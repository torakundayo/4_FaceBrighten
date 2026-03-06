# Face Brighten

逆光・影で暗くなった人物写真の顔を、AI + プロ品質のカラーグレーディングで自動補正するWebツール。

**公開URL**: https://4-facebrighten.pages.dev/

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
| 認証 | Supabase Auth | Google OAuth + Email/Password、JWT |
| データベース | Supabase PostgreSQL | レート制限 (processing_logs) |
| GPUバックエンド | Modal.com (T4 GPU) | SegFormer推論 + 画像処理 |
| AIモデル | SegFormer (HuggingFace) | 顔セマンティックセグメンテーション |
| テスト | Vitest | バリデーション・定数のユニットテスト (31件) |
| CI/CD | GitHub → Cloudflare Pages | push時自動デプロイ |

## セキュリティ

| 対策 | 実装 |
|------|------|
| 認証 | Supabase JWT検証 (サーバーサイド) |
| CSRF保護 | Origin/Refererヘッダー検証 (環境変数で設定可能) |
| ファイル検証 | マジックバイトによる実際のファイル形式チェック |
| パストラバーサル防止 | R2キーの正規表現バリデーション |
| API認証 | HMAC (タイミング攻撃対策: `hmac.compare_digest`) |
| データ分離 | RLS + ユーザーIDプレフィクスによるアクセス制御 |
| レート制限 | 日次/月次制限 + 同時実行制御 |

## ディレクトリ構成

```
4_FaceBrighten/
├── backend/
│   ├── modal_app.py          # Modal サーバーレスGPUアプリ (FastAPI)
│   ├── image_processor.py    # 画像処理コアロジック
│   ├── requirements.txt
│   └── SETUP.md              # バックエンドセットアップガイド
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── ImageProcessor.tsx   # メイン処理UI (D&D, プログレス, スライダー)
│   │   │   ├── AuthForm.tsx         # ログイン/サインアップ (Google OAuth + Email)
│   │   │   ├── BeforeAfterSlider.tsx # Before/After比較スライダー
│   │   │   ├── Features.astro       # 技術的特長セクション
│   │   │   ├── ProcessFlow.astro    # 処理フロー図解セクション
│   │   │   ├── Pricing.astro        # 料金プランセクション
│   │   │   └── FAQ.astro            # よくある質問セクション
│   │   ├── pages/
│   │   │   ├── index.astro          # ランディングページ
│   │   │   ├── login.astro          # 認証ページ
│   │   │   ├── app.astro            # ツール本体（要認証）
│   │   │   └── api/
│   │   │       ├── process.ts       # 画像アップロード + Modal呼び出し
│   │   │       ├── download.ts      # 認証付きR2ダウンロード
│   │   │       ├── usage.ts         # レート制限 + タイムアウト復旧 + ログクリーンアップ
│   │   │       └── warmup.ts        # GPUプリウォーム
│   │   ├── lib/
│   │   │   ├── auth.ts              # サーバーサイドJWT検証 + Supabaseクライアント
│   │   │   ├── supabase.ts          # クライアントサイドSupabase
│   │   │   ├── validation.ts        # 入力検証 (画像形式, R2キー, CSRF)
│   │   │   ├── validation.test.ts   # バリデーションテスト (27件)
│   │   │   ├── constants.ts         # 共通定数 (制限値, タイムアウト)
│   │   │   ├── constants.test.ts    # 定数テスト (4件)
│   │   │   └── r2.ts               # R2操作ヘルパー
│   │   ├── layouts/
│   │   │   └── Layout.astro         # 共通レイアウト (OGP, フォント)
│   │   ├── styles/
│   │   │   └── global.css           # Tailwind v4 テーマ定義
│   │   └── env.d.ts                 # TypeScript型定義 (CF Bindings)
│   ├── public/
│   │   ├── demo/                    # Before/Afterデモ画像
│   │   └── favicon.svg
│   ├── .env.example
│   ├── SETUP.md                     # フロントエンドセットアップガイド
│   └── package.json
├── PLAN.md                          # 詳細設計書 (603行)
├── REPORT_顔補正カラーグレーディング.md  # AI処理の技術レポート
├── brighten_face.py                 # 元のスタンドアロンスクリプト
└── face_segmentation.py             # 元のスタンドアロンスクリプト
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

GitHub連携による自動デプロイ:

1. GitHubリポジトリをCloudflare Pagesに接続
2. ビルド設定:
   - Build command: `npm run build`
   - Build output directory: `dist`
   - Root directory: `frontend`
3. 環境変数を Settings > Environment variables に設定（暗号化推奨）
4. R2バインディングを Settings > Bindings に設定: `R2_BUCKET` = `image-processing`

### 3. Supabase

1. https://supabase.com でプロジェクトを作成
2. `frontend/SETUP.md` のSQLスキーマを実行（processing_logsテーブル + RLS）
3. Authentication > Providers で Google OAuthを有効化
4. Site URLとRedirect URLsを設定

### 4. Cloudflare R2

1. バケットを作成: `image-processing`
2. ライフサイクルルール: `uploads/` と `results/` を1日で自動削除
3. Pagesにバインド: Settings > Bindings > R2 bucket > `R2_BUCKET`

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

## 運用設計

- **画像の自動削除**: R2ライフサイクルルールで1日後に自動削除
- **タイムアウト復旧**: 5分以上processingのまま放置されたジョブを自動でfailedに変更
- **ログクリーンアップ**: 30日以上経過したprocessing_logsを自動削除
- **GPUプリウォーム**: ページロード時にModalコンテナを事前起動（コールドスタート対策）

## ライセンス

MIT
