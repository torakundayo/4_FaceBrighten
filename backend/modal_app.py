"""
Modal.com サーバーレスGPUアプリケーション

SegFormer顔セグメンテーション + DaVinci Resolve式カラーグレーディングを
サーバーレスGPU (T4) 上で実行する。

エンドポイント:
  POST /process  - 画像処理（R2経由）
  POST /warmup   - コンテナのプリウォーム
"""

import hashlib
import hmac
import io
import os
import re
import time
import uuid

import modal

app = modal.App("face-brighten")

# GPU コンテナイメージの定義
gpu_image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "torch==2.4.0",
        "torchvision==0.19.0",
        "transformers>=4.44.0",
        "opencv-python-headless>=4.10.0",
        "numpy>=1.26.0",
        "Pillow>=10.4.0",
        "boto3>=1.34.0",
        "fastapi[standard]",
    )
    .add_local_file("image_processor.py", "/app/image_processor.py")
)


def create_r2_client():
    """Cloudflare R2 (S3互換) クライアントを作成"""
    import boto3

    return boto3.client(
        "s3",
        endpoint_url=os.environ["R2_ENDPOINT_URL"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )


@app.cls(
    image=gpu_image,
    gpu="T4",
    timeout=300,
    scaledown_window=300,
    secrets=[modal.Secret.from_name("r2-credentials")],
)
class ImageProcessor:
    @modal.enter()
    def load_model(self):
        """コンテナ起動時にモデルをGPUに読み込み（1回だけ実行）"""
        import sys

        sys.path.insert(0, "/app")
        from image_processor import load_face_parser

        self.processor, self.model, self.device = load_face_parser()
        self.r2 = create_r2_client()
        self.bucket = os.environ.get("R2_BUCKET_NAME", "image-processing")
        print(f"Model loaded on {self.device}")

    @modal.fastapi_endpoint(method="POST")
    def process(self, data: dict):
        """
        画像処理エンドポイント

        Request body:
            {
                "input_key": "uploads/{user_id}/{uuid}.jpg",
                "api_secret": "shared secret for auth"
            }

        Response:
            {
                "result_key": "results/{user_id}/{uuid}_processed.jpg",
                "stats": { ... },
                "process_sec": 8.2
            }
        """
        import sys

        sys.path.insert(0, "/app")
        from image_processor import process_image

        start_time = time.time()

        # 認証チェック（タイミング攻撃対策: hmac.compare_digest）
        api_secret = data.get("api_secret", "")
        expected_secret = os.environ.get("API_SECRET", "")
        if not expected_secret or not hmac.compare_digest(api_secret, expected_secret):
            return {"error": "Unauthorized"}, 401

        input_key = data.get("input_key", "")

        # input_key のフォーマット検証（パストラバーサル防止）
        # 期待形式: uploads/{uuid}/{uuid}.{ext}
        if not re.match(
            r"^uploads/[0-9a-f\-]{36}/[0-9a-f\-]{36}\.(jpg|jpeg|png)$",
            input_key,
        ):
            return {"error": "Invalid input_key format"}, 400

        # R2から入力画像をダウンロード
        try:
            response = self.r2.get_object(Bucket=self.bucket, Key=input_key)
            image_bytes = response["Body"].read()
        except Exception:
            return {"error": "Failed to download image"}, 500

        # PIL Imageに変換
        from PIL import Image, PngImagePlugin

        pil_orig = Image.open(io.BytesIO(image_bytes))
        icc_profile = pil_orig.info.get("icc_profile")
        pil_image = pil_orig.convert("RGB")

        # 画像サイズ制限チェック（長辺4000px）
        max_dim = 4000
        w, h = pil_image.size
        if max(w, h) > max_dim:
            scale = max_dim / max(w, h)
            new_w = int(w * scale)
            new_h = int(h * scale)
            pil_image = pil_image.resize((new_w, new_h), Image.LANCZOS)

        # 処理実行
        result_image, stats = process_image(
            pil_image, self.processor, self.model, self.device
        )

        # 結果をR2にアップロード（PNG: 背景ピクセルを完全保持）
        # 拡張子を除去してから _processed.png を付与
        base_key = input_key.replace("uploads/", "results/")
        for ext in (".jpg", ".jpeg", ".png"):
            if base_key.endswith(ext):
                base_key = base_key[: -len(ext)]
                break
        result_key = base_key + "_processed.png"

        result_buffer = io.BytesIO()
        # ICCプロファイルを保持してPNG保存（ブラウザが同じ色空間で表示）
        save_kwargs = {}
        if icc_profile:
            save_kwargs["icc_profile"] = icc_profile
        result_image.save(result_buffer, format="PNG", **save_kwargs)
        result_buffer.seek(0)

        self.r2.put_object(
            Bucket=self.bucket,
            Key=result_key,
            Body=result_buffer.getvalue(),
            ContentType="image/png",
        )

        process_sec = round(time.time() - start_time, 1)

        return {
            "result_key": result_key,
            "stats": stats,
            "process_sec": process_sec,
        }

    @modal.fastapi_endpoint(method="POST")
    def warmup(self, data: dict = {}):
        """コンテナのプリウォームエンドポイント"""
        return {
            "status": "warm",
            "device": str(self.device),
            "model": "jonathandinu/face-parsing",
        }
