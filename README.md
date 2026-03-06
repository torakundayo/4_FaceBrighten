# Face Brighten

逆光・影で暗くなった人物写真の顔を、AI + プロ品質のカラーグレーディングで自動補正するWebツール。

**公開URL**: https://face-brighten.pages.dev/

## 概要

SegFormer AIが顔をピクセル単位でセグメンテーションし、DaVinci Resolve式のLift/Gamma/Offset カラーグレーディングで顔の明るさを自然に補正します。背景は1ピクセルも変更しません。

### 処理パイプライン

1. **SegFormer AI** - 顔のパーツをセマンティックセグメンテーション（肌・目・鼻・口・首など）
2. **マスク生成** - 暗さの重み付け + ガウシアンブラーで滑らかな補正マスクを生成
3. **カラーグレーディング** - 輝度統計から目標値を自動算出し、Lift/Gamma/Offset を適用
4. **スキントーン保持** - ベクトルスコープのスキントーンライン上に色を維持
5. **肌スムージング** - バイラテラルフィルタで肌領域のみ軽くスムージング

## アーキテクチャ

```
ブラウザ
  │
  ├─→ Cloudflare Pages (Astro 5 SSR)
  │     ├── ランディングページ
  │     ├── 認証 (Supabase OAuth)
  │     └── APIルート (/api/process, /api/download)
  │           │
  │           ├─→ Supabase (認証 + レート制限DB)
  │           ├─→ Cloudflare R2 (画像ストレージ)
  │           └─→ Modal.com (サーバーレスGPU - T4)
  │                 ├── SegFormer (jonathandinu/face-parsing)
  │                 └── カラーグレーディングパイプライン
  │
  └─← 結果 (Before/After プレビュー + ダウンロード)
```

## 技術スタック

| レイヤー | 技術 | 用途 |
|---------|------|------|
| フロントエンド | Astro 5 + React 19 + Tailwind CSS v4 | SSR + インタラクティブIslands |
| ホスティング | Cloudflare Pages | SSR、APIルート、R2バインディング |
| ストレージ | Cloudflare R2 | 画像のアップロード/ダウンロード (S3互換) |
| 認証 | Supabase Auth | Google OAuth、JWT |
| データベース | Supabase PostgreSQL | レート制限 (processing_logs) |
| GPUバックエンド | Modal.com (T4 GPU) | SegFormer推論 + 画像処理 |
| AIモデル | SegFormer (HuggingFace) | 顔セマンティックセグメンテーション |

## ディレクトリ構成

```
4_FaceBrighten/
├── backend/
│   ├── modal_app.py          # Modal サーバーレスGPUアプリ
│   ├── image_processor.py    # 画像処理コアロジック
│   ├── requirements.txt
│   └── SETUP.md              # バックエンドセットアップガイド
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── ImageProcessor.tsx   # メイン処理UI
│   │   │   ├── AuthForm.tsx         # ログイン/サインアップ
│   │   │   └── BeforeAfterSlider.tsx
│   │   ├── pages/
│   │   │   ├── index.astro          # ランディングページ
│   │   │   ├── login.astro          # 認証ページ
│   │   │   ├── app.astro            # ツール本体（要認証）
│   │   │   └── api/
│   │   │       ├── process.ts       # 画像アップロード + Modal呼び出し
│   │   │       ├── download.ts      # 認証付きR2ダウンロード
│   │   │       ├── usage.ts         # レート制限状況
│   │   │       └── warmup.ts        # GPUプリウォーム
│   │   ├── lib/
│   │   │   ├── auth.ts              # サーバーサイドJWT検証
│   │   │   └── supabase.ts          # クライアントサイドSupabase
│   │   └── layouts/
│   │       └── Layout.astro
│   ├── .env.example
│   ├── wrangler.toml
│   ├── SETUP.md              # フロントエンドセットアップガイド
│   └── package.json
├── brighten_face.py          # 元のスタンドアロンスクリプト
├── face_segmentation.py      # 元のスタンドアロンスクリプト
└── PLAN.md                   # 詳細設計書
```

## セットアップ

### 前提条件

- Node.js 18+
- Python 3.10+
- [Modal CLI](https://modal.com/docs/guide)
- Cloudflare アカウント (Pages + R2)
- Supabase アカウント

### 1. バックエンド (Modal.com)

```bash
pip install modal
modal setup

cd backend
# R2認証情報を含むModal Secretを作成
modal secret create r2-credentials \
  R2_ENDPOINT_URL="https://<account-id>.r2.cloudflarestorage.com" \
  R2_ACCESS_KEY_ID="..." \
  R2_SECRET_ACCESS_KEY="..." \
  R2_BUCKET_NAME="image-processing" \
  API_SECRET="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"

# デプロイ
python -m modal deploy modal_app.py
```

### 2. フロントエンド (Cloudflare Pages)

```bash
cd frontend
cp .env.example .env
# .env を編集してSupabase/Modalの認証情報を設定

npm install
npm run build
npx wrangler pages deploy dist --project-name=face-brighten
```

### 3. Supabase

1. https://supabase.com でプロジェクトを作成
2. `frontend/SETUP.md` のSQLスキーマを実行（processing_logsテーブル + RLS）
3. Authentication > Providers で Google OAuthを有効化
4. Site URLとRedirect URLsを設定

### 4. Cloudflare R2

1. バケットを作成: `image-processing`
2. Pagesにバインド: Settings > Functions > R2 bucket bindings > `R2_BUCKET`

詳細は [frontend/SETUP.md](frontend/SETUP.md) と [backend/SETUP.md](backend/SETUP.md) を参照してください。

## 利用制限

| 項目 | 無料プラン |
|------|-----------|
| 1日あたり | 5枚 |
| 1ヶ月あたり | 50枚 |
| 最大ファイルサイズ | 10 MB |
| 最大解像度 | 4000 px（長辺） |
| 同時処理 | 1枚 |

## 運用コスト

すべて各サービスの無料枠内で運用可能です。

| サービス | 無料枠 | 想定使用量 |
|---------|--------|-----------|
| Cloudflare Pages | リクエスト無制限 | - |
| Cloudflare R2 | 10 GBストレージ、送信無料 | 1 GB未満 |
| Supabase | 50K MAU、500 MB DB | 1K MAU未満 |
| Modal.com | $30/月 GPUクレジット | 約$1-5/月 |

## ライセンス

MIT
