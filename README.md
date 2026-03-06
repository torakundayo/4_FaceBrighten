# Face Brighten

逆光・影で暗くなった人物写真の顔を、AI + プロ品質のカラーグレーディングで自動補正するWebツール。

**Live Demo**: https://face-brighten.pages.dev/

## Overview

SegFormer AIが顔をピクセル単位でセグメンテーションし、DaVinci Resolve式のLift/Gamma/Offset カラーグレーディングで顔の明るさを自然に補正します。背景は1ピクセルも変更しません。

### Processing Pipeline

1. **SegFormer AI** - 顔のパーツをセマンティックセグメンテーション（肌・目・鼻・口・首など）
2. **マスク生成** - 暗さの重み付け + ガウシアンブラーで滑らかな補正マスクを生成
3. **カラーグレーディング** - 輝度統計から目標値を自動算出し、Lift/Gamma/Offset を適用
4. **スキントーン保持** - ベクトルスコープのスキントーンライン上に色を維持
5. **肌スムージング** - バイラテラルフィルタで肌領域のみ軽くスムージング

## Architecture

```
Browser
  │
  ├─→ Cloudflare Pages (Astro 5 SSR)
  │     ├── LP (Landing Page)
  │     ├── Auth (Supabase OAuth)
  │     └── API Routes (/api/process, /api/download)
  │           │
  │           ├─→ Supabase (Auth + Rate Limiting DB)
  │           ├─→ Cloudflare R2 (Image Storage)
  │           └─→ Modal.com (Serverless GPU - T4)
  │                 ├── SegFormer (jonathandinu/face-parsing)
  │                 └── Color Grading Pipeline
  │
  └─← Result (Before/After Preview + Download)
```

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Frontend | Astro 5 + React 19 + Tailwind CSS v4 | SSR + Interactive Islands |
| Hosting | Cloudflare Pages | SSR, API Routes, R2 binding |
| Storage | Cloudflare R2 | Image upload/download (S3-compatible) |
| Auth | Supabase Auth | Google OAuth, JWT |
| Database | Supabase PostgreSQL | Rate limiting (processing_logs) |
| GPU Backend | Modal.com (T4 GPU) | SegFormer inference + image processing |
| AI Model | SegFormer (HuggingFace) | Face semantic segmentation |

## Project Structure

```
4_FaceBrighten/
├── backend/
│   ├── modal_app.py          # Modal serverless GPU app
│   ├── image_processor.py    # Core image processing pipeline
│   ├── requirements.txt
│   └── SETUP.md              # Backend setup guide
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── ImageProcessor.tsx   # Main processing UI
│   │   │   ├── AuthForm.tsx         # Login/signup form
│   │   │   └── BeforeAfterSlider.tsx
│   │   ├── pages/
│   │   │   ├── index.astro          # Landing page
│   │   │   ├── login.astro          # Auth page
│   │   │   ├── app.astro            # Tool page (auth required)
│   │   │   └── api/
│   │   │       ├── process.ts       # Image upload + Modal call
│   │   │       ├── download.ts      # Authenticated R2 download
│   │   │       ├── usage.ts         # Rate limit status
│   │   │       └── warmup.ts        # GPU pre-warm
│   │   ├── lib/
│   │   │   ├── auth.ts              # Server-side JWT verification
│   │   │   └── supabase.ts          # Client-side Supabase
│   │   └── layouts/
│   │       └── Layout.astro
│   ├── .env.example
│   ├── wrangler.toml
│   ├── SETUP.md              # Frontend setup guide
│   └── package.json
├── brighten_face.py          # Original standalone script
├── face_segmentation.py      # Original standalone script
└── PLAN.md                   # Detailed design document
```

## Setup

### Prerequisites

- Node.js 18+
- Python 3.10+
- [Modal CLI](https://modal.com/docs/guide)
- Cloudflare account (Pages + R2)
- Supabase account

### 1. Backend (Modal.com)

```bash
pip install modal
modal setup

cd backend
# Create Modal secret with R2 credentials
modal secret create r2-credentials \
  R2_ENDPOINT_URL="https://<account-id>.r2.cloudflarestorage.com" \
  R2_ACCESS_KEY_ID="..." \
  R2_SECRET_ACCESS_KEY="..." \
  R2_BUCKET_NAME="image-processing" \
  API_SECRET="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"

# Deploy
python -m modal deploy modal_app.py
```

### 2. Frontend (Cloudflare Pages)

```bash
cd frontend
cp .env.example .env
# Edit .env with your Supabase/Modal credentials

npm install
npm run build
npx wrangler pages deploy dist --project-name=face-brighten
```

### 3. Supabase

1. Create project at https://supabase.com
2. Run the SQL schema from `frontend/SETUP.md` (processing_logs table + RLS)
3. Enable Google OAuth in Authentication > Providers
4. Set Site URL and Redirect URLs

### 4. Cloudflare R2

1. Create bucket: `image-processing`
2. Bind to Pages: Settings > Functions > R2 bucket bindings > `R2_BUCKET`

See [frontend/SETUP.md](frontend/SETUP.md) and [backend/SETUP.md](backend/SETUP.md) for detailed instructions.

## Rate Limits

| | Free |
|---|---|
| Daily | 5 images |
| Monthly | 50 images |
| Max file size | 10 MB |
| Max resolution | 4000 px (long side) |
| Concurrent | 1 |

## Cost

All services used are within free tiers:

| Service | Free Tier | Typical Usage |
|---------|-----------|--------------|
| Cloudflare Pages | Unlimited requests | - |
| Cloudflare R2 | 10 GB storage, free egress | < 1 GB |
| Supabase | 50K MAU, 500 MB DB | < 1K MAU |
| Modal.com | $30/month GPU credit | ~$1-5/month |

## License

MIT
