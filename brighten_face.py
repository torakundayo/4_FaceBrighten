"""
逆光画像の顔領域を自然に明るく補正するスクリプト

手法:
1. OpenCV YuNet DNN で顔領域を高精度に検出（横顔にも対応）
2. Haar カスケード（横顔+正面）をフォールバック
3. 検出した顔領域を拡張し、ガウシアンブラーで滑らかなマスクを生成
4. LAB色空間でシャドウ回復（Lightroomの「シャドウ」スライダーに相当）
5. CLAHE でローカルコントラストを維持
6. 彩度補正で色の自然さを維持
7. EXIF保持で高品質JPEG出力
"""

import cv2
import numpy as np
from pathlib import Path
from PIL import Image


def detect_face_yunet(img_bgr, model_path):
    """OpenCV YuNet DNN による高精度顔検出（横顔・遠距離に強い）"""
    h, w = img_bgr.shape[:2]

    # 高解像度画像は縮小してから検出（精度・速度向上）
    max_dim = 1000
    scale = 1.0
    if max(h, w) > max_dim:
        scale = max_dim / max(h, w)
        img_resized = cv2.resize(img_bgr, None, fx=scale, fy=scale)
    else:
        img_resized = img_bgr

    rh, rw = img_resized.shape[:2]

    detector = cv2.FaceDetectorYN.create(
        str(model_path),
        "",
        (rw, rh),
        score_threshold=0.6,
        nms_threshold=0.3,
        top_k=100,
    )

    _, raw_faces = detector.detect(img_resized)

    if raw_faces is None:
        # 信頼度を下げて再試行
        detector = cv2.FaceDetectorYN.create(
            str(model_path),
            "",
            (rw, rh),
            score_threshold=0.4,
            nms_threshold=0.3,
            top_k=100,
        )
        _, raw_faces = detector.detect(img_resized)

    faces = []
    if raw_faces is not None:
        for face in raw_faces:
            # 元の解像度に座標を戻す
            x = int(face[0] / scale)
            y = int(face[1] / scale)
            fw = int(face[2] / scale)
            fh = int(face[3] / scale)
            confidence = float(face[-1])
            faces.append((x, y, fw, fh, confidence))
            print(f"  YuNet顔検出: 位置=({x},{y}), サイズ=({fw}x{fh}), 信頼度={confidence:.3f}")

    return faces


def detect_face_haar(gray):
    """Haarカスケードによるフォールバック検出（正面+横顔）"""
    faces = []

    # 横顔カスケード
    profile_cascade = cv2.CascadeClassifier(
        cv2.data.haarcascades + 'haarcascade_profileface.xml'
    )
    profile_faces = profile_cascade.detectMultiScale(gray, 1.05, 3, minSize=(50, 50))
    for (x, y, w, h) in profile_faces:
        faces.append((x, y, w, h, 0.5))
        print(f"  Haar横顔検出: 位置=({x},{y}), サイズ=({w}x{h})")

    # 左右反転して再試行（右向き横顔）
    if len(faces) == 0:
        flipped = cv2.flip(gray, 1)
        profile_faces_flip = profile_cascade.detectMultiScale(flipped, 1.05, 3, minSize=(50, 50))
        img_w = gray.shape[1]
        for (x, y, w, h) in profile_faces_flip:
            # 座標を元に戻す
            x_orig = img_w - x - w
            faces.append((x_orig, y, w, h, 0.4))
            print(f"  Haar横顔検出(反転): 位置=({x_orig},{y}), サイズ=({w}x{h})")

    # 正面カスケード
    if len(faces) == 0:
        frontal_cascade = cv2.CascadeClassifier(
            cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
        )
        frontal_faces = frontal_cascade.detectMultiScale(gray, 1.05, 3, minSize=(50, 50))
        for (x, y, w, h) in frontal_faces:
            faces.append((x, y, w, h, 0.5))
            print(f"  Haar正面検出: 位置=({x},{y}), サイズ=({w}x{h})")

    return faces


def create_face_mask(img_shape, faces, expand_ratio=2.5):
    """検出した顔領域からソフトマスクを生成"""
    h, w = img_shape[:2]
    mask = np.zeros((h, w), dtype=np.float32)

    for (fx, fy, fw, fh, _) in faces:
        # 顔の中心を計算
        cx = fx + fw // 2
        cy = fy + fh // 2

        # 顔領域を拡張（首・上半身も含む）
        radius_x = int(fw * expand_ratio)
        radius_y = int(fh * expand_ratio)

        # 楕円マスクで顔〜上半身をカバー
        # 中心を上方に寄せ（顔・首を重点的にカバー）
        cy_shifted = max(cy - int(fh * 0.3), 0)
        cv2.ellipse(
            mask, (cx, cy_shifted),
            (radius_x, radius_y),
            0, 0, 360, 1.0, -1
        )

    # ガウシアンブラーでマスクをソフトに（境界のなだらかな遷移）
    blur_size = max(h, w) // 5
    if blur_size % 2 == 0:
        blur_size += 1
    mask = cv2.GaussianBlur(mask, (blur_size, blur_size), 0)

    # マスクを正規化
    if mask.max() > 0:
        mask = mask / mask.max()

    return mask


def create_shadow_mask(img_bgr):
    """
    フォールバック: 輝度ベースのシャドウマスク + 空間重み
    顔検出が失敗した場合に使用
    """
    h, w = img_bgr.shape[:2]
    lab = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2LAB)
    l_channel = lab[:, :, 0].astype(np.float32)

    # シャドウ領域の特定（暗い部分）
    shadow_thresh = np.percentile(l_channel, 45)
    shadow_mask = np.clip((shadow_thresh - l_channel) / max(shadow_thresh, 1), 0, 1)

    # 空間重み: 人物がいそうな領域（画像の中央～左寄り、下半分）
    y_coords = np.linspace(0, 1, h).reshape(-1, 1)
    x_coords = np.linspace(0, 1, w).reshape(1, -1)

    spatial = np.ones((h, w), dtype=np.float32)
    # 左端・右端をフェードアウト
    spatial *= np.clip(x_coords / 0.1, 0, 1)
    spatial *= np.clip((0.8 - x_coords) / 0.15, 0, 1)
    # 上端をフェードアウト（空を含めない）
    spatial *= np.clip((y_coords - 0.1) / 0.15, 0, 1)
    # 下端をフェードアウト（地面を含めすぎない）
    spatial *= np.clip((0.95 - y_coords) / 0.2, 0.2, 1.0)

    mask = shadow_mask * spatial

    # ソフトブラー
    blur_size = max(h, w) // 5
    if blur_size % 2 == 0:
        blur_size += 1
    mask = cv2.GaussianBlur(mask, (blur_size, blur_size), 0)

    if mask.max() > 0:
        mask = mask / mask.max()

    return mask


def shadow_lift_curve(l_channel, strength=0.45):
    """
    シャドウリフトのトーンカーブ
    暗い値ほど大きく持ち上げ、明るい値はほぼそのまま
    Lightroomの「シャドウ」スライダーと同等の効果
    """
    l_norm = l_channel / 255.0

    # シャドウリフト: 暗い部分をより強く持ち上げる（2乗カーブ）
    boost = strength * (1.0 - l_norm) ** 2
    l_new = l_norm + boost

    # ソフトクリップ（白飛びを防ぐ）
    l_new = np.where(l_new > 0.95, 0.95 + (l_new - 0.95) * 0.2, l_new)

    return np.clip(l_new * 255, 0, 255)


def apply_local_contrast(l_channel, mask, strength=0.15):
    """
    ローカルコントラスト補正
    明るくした領域のディテールを維持するためCLAHEを適用
    """
    l_uint8 = np.clip(l_channel, 0, 255).astype(np.uint8)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    l_clahe = clahe.apply(l_uint8).astype(np.float32)

    # マスク領域にのみ部分的にCLAHEを適用
    l_result = l_channel * (1 - mask * strength) + l_clahe * (mask * strength)
    return l_result


def brighten_face(input_path, output_path, model_path, shadow_strength=0.45, debug=False):
    """メイン処理"""
    print(f"入力: {input_path}")

    # 画像読み込み
    img_bgr = cv2.imread(str(input_path))
    if img_bgr is None:
        raise FileNotFoundError(f"画像を読み込めません: {input_path}")

    h, w = img_bgr.shape[:2]
    print(f"画像サイズ: {w}x{h}")

    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)

    # --- Step 1: 顔検出 ---
    print("\n[Step 1] 顔検出...")

    faces = []

    # 方法1: YuNet DNN 顔検出（最高精度）
    if model_path and Path(model_path).exists():
        print("  YuNet DNN顔検出を使用...")
        faces = detect_face_yunet(img_bgr, model_path)

    # 方法2: Haarカスケード（フォールバック）
    if len(faces) == 0:
        print("  YuNetで顔が検出されませんでした。Haarカスケードを試行...")
        faces = detect_face_haar(gray)

    # --- Step 2: マスク生成 ---
    print("\n[Step 2] マスク生成...")

    # 輝度ベースのシャドウマスクは常に作成（暗い部分の特定）
    shadow_mask = create_shadow_mask(img_bgr)

    if len(faces) > 0:
        print(f"  {len(faces)}個の顔に基づいてマスクを生成")
        face_mask = create_face_mask(img_bgr.shape, faces, expand_ratio=2.5)
        # ハイブリッド: 顔マスク × シャドウマスクで、
        # 顔周辺かつ暗い部分だけをターゲット
        mask = np.maximum(face_mask * shadow_mask * 1.5, shadow_mask * 0.3)
        mask = np.clip(mask, 0, 1)
        # ソフトブラーで滑らかに
        blur_size = max(h, w) // 8
        if blur_size % 2 == 0:
            blur_size += 1
        mask = cv2.GaussianBlur(mask, (blur_size, blur_size), 0)
        if mask.max() > 0:
            mask = mask / mask.max()
    else:
        print("  顔検出失敗 → 輝度ベースのシャドウマスクを使用")
        mask = shadow_mask

    # --- Step 3: LAB色空間でシャドウ回復 ---
    print("\n[Step 3] シャドウ回復（LAB色空間）...")
    lab = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2LAB)
    l_channel = lab[:, :, 0].astype(np.float32)
    a_channel = lab[:, :, 1].astype(np.float32)
    b_channel = lab[:, :, 2].astype(np.float32)

    # シャドウリフト
    l_lifted = shadow_lift_curve(l_channel, strength=shadow_strength)

    # ローカルコントラスト補正（ディテール維持）
    l_lifted = apply_local_contrast(l_lifted, mask, strength=0.15)

    # マスクに基づいてブレンド
    l_result = l_channel * (1 - mask) + l_lifted * mask

    # --- Step 4: 彩度補正 ---
    print("[Step 4] 彩度補正...")
    # シャドウを持ち上げると彩度が薄く見えるため、少し補正
    sat_boost = 1.0 + 0.12 * mask
    a_result = 128 + (a_channel - 128) * sat_boost
    b_result = 128 + (b_channel - 128) * sat_boost

    # LABチャンネルを再構成
    lab[:, :, 0] = np.clip(l_result, 0, 255).astype(np.uint8)
    lab[:, :, 1] = np.clip(a_result, 0, 255).astype(np.uint8)
    lab[:, :, 2] = np.clip(b_result, 0, 255).astype(np.uint8)

    result_bgr = cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)

    # --- Step 5: EXIF保持して保存 ---
    print("\n[Step 5] 保存...")

    # PillowでEXIFを読み取り
    pil_orig = Image.open(str(input_path))
    exif_data = pil_orig.info.get('exif', None)

    # OpenCVの結果をPillowに変換して保存（EXIF保持）
    result_rgb = cv2.cvtColor(result_bgr, cv2.COLOR_BGR2RGB)
    pil_result = Image.fromarray(result_rgb)

    save_kwargs = {'quality': 95, 'subsampling': 0}  # 最高品質JPEG
    if exif_data:
        save_kwargs['exif'] = exif_data
        print("  EXIFデータを保持")

    pil_result.save(str(output_path), 'JPEG', **save_kwargs)
    print(f"  出力: {output_path}")

    # デバッグ: マスクを保存
    if debug:
        mask_path = output_path.parent / (output_path.stem + "_mask.jpg")
        mask_vis = (mask * 255).astype(np.uint8)
        cv2.imwrite(str(mask_path), mask_vis)
        print(f"  マスク: {mask_path}")

    # 統計情報
    orig_l = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2LAB)[:, :, 0]
    result_l = lab[:, :, 0]
    face_region = mask > 0.5
    if face_region.any():
        orig_mean = orig_l[face_region].mean()
        result_mean = result_l[face_region].mean()
        print(f"\n[結果] 顔領域の平均輝度: {orig_mean:.1f} → {result_mean:.1f} (+{result_mean-orig_mean:.1f})")

    print("完了！")
    return result_bgr


if __name__ == "__main__":
    input_dir = Path(r"d:\LLM作業フォルダ\画像処理")
    input_file = input_dir / "2025 1114_MG_5181.jpg"
    output_file = input_dir / "2025 1114_MG_5181_brightened.jpg"
    model_file = input_dir / "face_detection_yunet_2023mar.onnx"

    brighten_face(input_file, output_file, model_file, shadow_strength=0.45, debug=True)
