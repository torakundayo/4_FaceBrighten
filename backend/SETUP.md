# Backend セットアップガイド

## 1. Modal.com アカウント作成

1. https://modal.com にアクセス
2. GitHubアカウントでサインアップ
3. 月$30の無料クレジットが自動付与される

## 2. Modal CLI インストール

```bash
pip install modal
modal setup  # ブラウザでログイン認証
```

## 3. Cloudflare R2 バケット作成

1. Cloudflare ダッシュボード → R2 Object Storage
2. 「Create bucket」→ バケット名: `image-processing`
3. R2 API トークン作成:
   - R2 → Overview → 「Manage R2 API Tokens」
   - 「Create API token」
   - Permissions: Object Read & Write
   - Specify bucket: `image-processing`
   - 作成後、以下をメモ:
     - Access Key ID
     - Secret Access Key
     - S3 API endpoint (例: `https://<account-id>.r2.cloudflarestorage.com`)

4. ライフサイクルルール設定:
   - バケット → Settings → Object lifecycle rules
   - Rule 1: Prefix `uploads/` → Delete after 1 day
   - Rule 2: Prefix `results/` → Delete after 1 day

## 4. Modal Secrets 設定

```bash
modal secret create r2-credentials \
  R2_ENDPOINT_URL="https://<account-id>.r2.cloudflarestorage.com" \
  R2_ACCESS_KEY_ID="your-access-key-id" \
  R2_SECRET_ACCESS_KEY="your-secret-access-key" \
  R2_BUCKET_NAME="image-processing" \
  API_SECRET="your-random-secret-string"
```

API_SECRET は Workers からの認証に使うランダム文字列。以下で生成可能:
```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

## 5. ローカルテスト

```bash
cd backend
modal serve modal_app.py
```

別ターミナルで:
```bash
curl -X POST http://localhost:8000/warmup \
  -H "Content-Type: application/json" \
  -d '{}'
```

## 6. デプロイ

```bash
modal deploy modal_app.py
```

デプロイ後、以下のURLが発行される:
- `https://<your-username>--face-brighten-imageprocessor-process.modal.run`
- `https://<your-username>--face-brighten-imageprocessor-warmup.modal.run`

これらのURLをフロントエンドの環境変数に設定する。
