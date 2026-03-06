# Frontend セットアップガイド

## 1. Supabase プロジェクト作成

### 1.1 プロジェクト作成
1. https://supabase.com にアクセス、GitHubでサインアップ
2. 「New Project」→ プロジェクト名: `face-brighten`
3. リージョン: `Northeast Asia (Tokyo)` 推奨
4. Database Password を設定（メモしておく）

### 1.2 APIキーの取得
Project Settings → API から以下をコピー:
- **Project URL**: `https://xxxxx.supabase.co`
- **anon public key**: `eyJ...`（PUBLIC_SUPABASE_ANON_KEY）
- **service_role key**: `eyJ...`（SUPABASE_SERVICE_ROLE_KEY）

### 1.3 データベーステーブル作成
SQL Editor で以下を実行:

```sql
-- 処理履歴テーブル
CREATE TABLE processing_logs (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID REFERENCES auth.users(id) NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now() NOT NULL,
  status      TEXT NOT NULL DEFAULT 'processing',
  input_key   TEXT NOT NULL,
  result_key  TEXT,
  file_size   INTEGER,
  width       INTEGER,
  height      INTEGER,
  process_sec FLOAT,
  stats       JSONB
);

-- インデックス（レート制限クエリ高速化）
CREATE INDEX idx_processing_logs_user_date
  ON processing_logs (user_id, created_at DESC);

CREATE INDEX idx_processing_logs_user_status
  ON processing_logs (user_id, status);

-- RLS有効化
ALTER TABLE processing_logs ENABLE ROW LEVEL SECURITY;

-- ユーザーは自分のログのみ閲覧可能
CREATE POLICY "Users can view own logs"
  ON processing_logs FOR SELECT
  USING (auth.uid() = user_id);

-- 認証済みユーザーはログを挿入可能
CREATE POLICY "Authenticated users can insert logs"
  ON processing_logs FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Service roleはすべての操作が可能（API経由で使用）
-- Note: service_role keyはRLSをバイパスするため、
-- サーバーサイドAPIで使用する
```

### 1.4 認証設定
Authentication → Providers:
- **Email**: 有効（デフォルト）
- **Google OAuth**（任意）:
  1. Google Cloud Console で OAuth 2.0 クライアントIDを作成
  2. Authorized redirect URI: `https://xxxxx.supabase.co/auth/v1/callback`
  3. Client ID と Client Secret を Supabase に設定

### 1.5 認証URL設定
Authentication → URL Configuration:
- Site URL: `https://face-brighten.pages.dev`（デプロイ後のURL）
- Redirect URLs: `https://face-brighten.pages.dev/app`

---

## 2. 環境変数の設定

`.env.example` を `.env` にコピーして値を設定:

```bash
cp .env.example .env
```

```
PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
MODAL_PROCESS_URL=https://your-username--face-brighten-imageprocessor-process.modal.run
MODAL_WARMUP_URL=https://your-username--face-brighten-imageprocessor-warmup.modal.run
MODAL_API_SECRET=（backend/SETUP.md で設定したのと同じ値）
```

---

## 3. ローカル開発

```bash
npm install
npm run dev
```

http://localhost:4321 でアクセス

> Note: ローカル開発ではR2バインディングが無いため、
> 画像処理APIは動作しません。LP と認証フローの確認のみ可能。

Wrangler でR2バインディング付きで開発する場合:
```bash
npx wrangler pages dev -- npm run dev
```

---

## 4. デプロイ

### 4.1 Cloudflare Pages にデプロイ

```bash
# 方法1: Wrangler CLI
npx wrangler pages deploy dist/

# 方法2: GitHub連携
# Cloudflare Dashboard → Pages → Create a project
# → Connect to Git → リポジトリ選択
# Build command: npm run build
# Build output directory: dist/
```

### 4.2 環境変数を Cloudflare Pages に設定

Cloudflare Dashboard → Pages → face-brighten → Settings → Environment variables:

| 変数名 | 値 | 暗号化 |
|--------|-----|--------|
| PUBLIC_SUPABASE_URL | https://xxxxx.supabase.co | No |
| PUBLIC_SUPABASE_ANON_KEY | eyJ... | No |
| SUPABASE_URL | https://xxxxx.supabase.co | Yes |
| SUPABASE_SERVICE_ROLE_KEY | eyJ... | Yes |
| MODAL_PROCESS_URL | https://...modal.run | Yes |
| MODAL_WARMUP_URL | https://...modal.run | No |
| MODAL_API_SECRET | ランダム文字列 | Yes |

### 4.3 R2 バインディングの設定

Cloudflare Dashboard → Pages → face-brighten → Settings → Functions:
- R2 bucket bindings → Variable name: `R2_BUCKET` → Bucket: `image-processing`

### 4.4 カスタムドメイン（任意）

Pages → Custom domains → Add custom domain

---

## 5. デプロイ順序チェックリスト

1. [ ] Supabase プロジェクト作成 + テーブル作成
2. [ ] Cloudflare R2 バケット作成（backend/SETUP.md 参照）
3. [ ] Modal.com セットアップ + デプロイ（backend/SETUP.md 参照）
4. [ ] `.env` ファイル作成、全環境変数を設定
5. [ ] `npm run build` でビルド確認
6. [ ] Cloudflare Pages にデプロイ
7. [ ] Cloudflare Pages に環境変数を設定
8. [ ] Cloudflare Pages に R2 バインディングを設定
9. [ ] Supabase の Site URL / Redirect URLs を更新
10. [ ] E2E テスト（サインアップ → ログイン → 画像処理 → ダウンロード）

---

## 6. デモ画像の準備

LP の Before/After デモに使う画像を `public/demo/` に配置:

```
public/demo/
├── before.jpg   ← 補正前の画像（逆光で顔が暗い写真）
└── after.jpg    ← 補正後の画像
```

既存の処理済み画像を使用する場合:
```bash
# 4_ImageProcessing ディレクトリから
cp "2025 1114_MG_5181.jpg" frontend/public/demo/before.jpg
cp "2025 1114_MG_5181_graded.jpg" frontend/public/demo/after.jpg
```

> Note: デモ画像は個人情報を含まないものを使用してください。
> 公開サイトに掲載されます。
