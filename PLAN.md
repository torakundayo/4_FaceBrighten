# 4_ImageProcessing 詳細設計計画

## 1. プロダクト概要

### コンセプト
逆光・影で暗くなった人物写真の顔を、プロのカラリスト品質で自動補正するWebツール。
SegFormer AIセグメンテーション + DaVinci Resolve式カラーグレーディングをクラウドGPUで実行。

### 公開モデル
- **LP（ランディングページ）**: 誰でもアクセス可。技術解説・Before/Afterデモ・使い方
- **ツール本体**: 認証済みユーザーのみ。無料枠あり（枚数制限付き）

---

## 2. アーキテクチャ

```
┌─────────────────────────────────────────────────────────────┐
│  ユーザーのブラウザ                                            │
│                                                              │
│  ① LP閲覧 → ② サインアップ/ログイン → ③ 画像アップロード       │
│  → ⑧ 処理結果プレビュー → ⑨ ダウンロード                      │
└──────────┬───────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────┐
│  Cloudflare Pages + Workers          │  ← フロントエンド + API
│  (Next.js via @opennextjs/cloudflare │
│   or Astro)                          │
│                                      │
│  ④ JWT検証（Supabase Auth）          │
│  ⑤ レート制限チェック（Supabase DB）  │
│  ⑥ 画像をR2に一時保存               │
│  ⑦ Modal APIを呼び出し              │
└──────┬──────────┬────────────────────┘
       │          │
       ▼          ▼
┌────────────┐  ┌──────────────────────────────┐
│ Supabase   │  │  Cloudflare R2               │
│            │  │  (S3互換オブジェクトストレージ)  │
│ - Auth     │  │                              │
│ - Users    │  │  - 入力画像（一時保存）        │
│ - 使用履歴 │  │  - 処理済み画像（一時保存）     │
│ - レート   │  │  - 1時間後に自動削除           │
│   制限管理 │  │                              │
└────────────┘  └──────────┬───────────────────┘
                           │
                           ▼
                ┌──────────────────────┐
                │  Modal.com           │
                │  (サーバーレスGPU)     │
                │                      │
                │  - T4 GPU            │
                │  - SegFormerモデル    │
                │  - Python処理        │
                │    パイプライン       │
                │                      │
                │  R2から画像取得       │
                │  → 処理              │
                │  → 結果をR2に保存     │
                │  → 完了通知を返却     │
                └──────────────────────┘
```

### なぜこの構成か

| 選択 | 理由 |
|------|------|
| Cloudflare Pages（Vercelではなく） | 商用利用OK（Vercel Hobbyは商用禁止）、R2とネイティブ連携 |
| Cloudflare R2 | 大容量ファイル中継（Vercelの4.5MB制限を回避）、egress無料 |
| Supabase Auth | 無料50K MAU、OAuth対応、PostgreSQLでレート制限管理 |
| Modal.com | サーバーレスGPU、Python直接実行、$30/月無料クレジット |

---

## 3. 処理フロー（詳細）

### 3.1 通常フロー（コンテナがwarm時）

```
ユーザー操作              Cloudflare Workers           Modal.com (GPU)
─────────────          ─────────────────          ──────────────────
画像選択
  │
  ├─→ [ウォームアップリクエスト]──→ /warmup ──→ コンテナ起動開始
  │   (ページ読み込み時に自動発火)              （バックグラウンド）
  │
アップロードボタン押下
  │
  ├─→ POST /api/process ──→ JWT検証
  │   (画像データ)            │
  │                          ├─→ レート制限チェック（Supabase）
  │                          │
  │                          ├─→ 画像をR2にアップロード
  │                          │   キー: uploads/{userId}/{uuid}.jpg
  │                          │
  │                          ├─→ Modal API呼び出し
  │                          │   POST modal-app.modal.run/process
  │                          │   body: { r2_key, settings }
  │                          │
  │                          │   ┌─── Modal内部 ───────────────┐
  │                          │   │ R2から画像ダウンロード       │
  │                          │   │ SegFormerセグメンテーション  │
  │                          │   │ マスク生成                   │
  │                          │   │ Lift/Gamma/Offsetグレーディング│
  │                          │   │ スキントーンベクトル保持     │
  │                          │   │ 肌スムージング               │
  │                          │   │ 結果をR2にアップロード       │
  │                          │   │   results/{userId}/{uuid}.jpg│
  │                          │   │ 使用統計をSupabaseに記録     │
  │                          │   └──────────────────────────────┘
  │                          │
  │                          ├─← 処理完了レスポンス
  │                          │   { result_key, stats }
  │                          │
  │                          ├─→ R2署名付きURL生成（1時間有効）
  │                          │
  ├─← レスポンス ─────────────┘
  │   { download_url, stats }
  │
プレビュー表示
Before/After比較
ダウンロード
```

### 3.2 コールドスタート対策

Modal.comは未使用時にコンテナを停止する。再起動には20-40秒かかる。

**対策: プリウォーム戦略**

```
1. ユーザーがツールページを開いた瞬間
   → バックグラウンドで /api/warmup を呼ぶ
   → Workers経由でModalの /warmup エンドポイントを叩く
   → Modalコンテナが起動し、モデルをGPUに読み込む

2. ユーザーが画像を選択・プレビューしている間（10-30秒）
   → この間にコンテナがwarmになる

3. アップロード時にはコンテナがwarm → 処理5-10秒で完了
```

**万が一コールドスタートに当たった場合のUX:**

```
処理中...
├── [ステップ 1/5] サーバー準備中... (コールドスタート: 20-40秒)
├── [ステップ 2/5] 顔のパーツを認識中...
├── [ステップ 3/5] 補正マスクを生成中...
├── [ステップ 4/5] カラーグレーディング中...
└── [ステップ 5/5] 画像を保存中...
```

---

## 4. 認証設計

### 4.1 Supabase Auth

| 項目 | 設定 |
|------|------|
| プロバイダー | Email/Password + Google OAuth |
| 無料枠 | 50,000 MAU |
| セッション管理 | Supabase JS SDK（JWTベース） |

### 4.2 ユーザーフロー

```
LP（未ログイン）
  │
  ├─→ [無料で試す] → サインアップ画面
  │                   ├── Googleで続ける（OAuth）
  │                   └── メールアドレスで登録
  │
  ├─→ [ログイン] → ログイン画面
  │
  └─→ [デモを見る] → Before/After静的画像（ログイン不要）

ツールページ（ログイン必須）
  │
  ├── 残り枚数表示: 「今日の残り: 3/5枚」
  ├── 画像アップロード
  ├── 処理結果プレビュー
  └── ダウンロード
```

### 4.3 ポートフォリオ連携

ポートフォリオサイト（#3 portfolio）からのリンク:
- ポートフォリオの「プロジェクト紹介」からLPへリンク
- 特別なリファラルパラメータ付きURL（?ref=portfolio）で
  初回ボーナス枚数を付与する等の施策も可能（将来）

---

## 5. レート制限設計

### 5.1 無料枠の予算制約

```
Modal.com 月額無料クレジット: $30

GPU使用コスト:
  - T4 GPU: $0.59/時間 = $0.000164/秒
  - 処理時間/枚（warm）: ~10秒 → $0.00164/枚
  - 処理時間/枚（cold）: ~40秒 → $0.00656/枚

月間予算 $30 で処理可能な枚数:
  - 全部warm: ~18,000枚/月
  - 50% cold: ~7,500枚/月
  - 全部cold: ~4,500枚/月

安全マージン込み（$25想定）: ~5,000枚/月
```

### 5.2 レート制限ルール

| 項目 | 無料ユーザー | 将来の有料ユーザー |
|------|-------------|------------------|
| 1日あたり | 5枚 | 50枚 |
| 1ヶ月あたり | 50枚 | 500枚 |
| 最大画像サイズ | 4000px（長辺） | 8000px |
| 最大ファイルサイズ | 10MB | 30MB |
| 処理結果の保持 | 1時間 | 24時間 |
| 同時処理 | 1枚 | 3枚 |

### 5.3 予算シミュレーション

| シナリオ | アクティブユーザー数 | 平均使用量 | 月間処理枚数 | 月額コスト |
|---------|--------------------:|----------:|------------:|-----------:|
| 立ち上げ期 | 10人 | 3枚/日 | 900枚 | ~$1.5 |
| 成長期 | 50人 | 2枚/日 | 3,000枚 | ~$5 |
| 上限想定 | 100人 | 2枚/日 | 6,000枚 | ~$10 |
| 最悪ケース | 200人 | 3枚/日 | 18,000枚 | ~$30（上限） |

100人までは余裕で無料枠内。200人を超えたら有料プラン検討。

### 5.4 Supabase DBスキーマ（レート制限用）

```sql
-- ユーザーの処理履歴
CREATE TABLE processing_logs (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID REFERENCES auth.users(id) NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now() NOT NULL,
  status      TEXT NOT NULL,  -- 'processing', 'completed', 'failed'
  input_key   TEXT NOT NULL,  -- R2のキー
  result_key  TEXT,           -- R2のキー（処理完了後）
  file_size   INTEGER,       -- バイト
  width       INTEGER,
  height      INTEGER,
  process_sec FLOAT,         -- 処理にかかった秒数
  stats       JSONB          -- 輝度変化等の統計情報
);

-- レート制限チェック用のビュー
CREATE VIEW user_usage AS
SELECT
  user_id,
  COUNT(*) FILTER (WHERE created_at > now() - INTERVAL '1 day')   AS today_count,
  COUNT(*) FILTER (WHERE created_at > now() - INTERVAL '1 month') AS month_count,
  COUNT(*) FILTER (WHERE status = 'processing')                    AS active_count
FROM processing_logs
GROUP BY user_id;

-- RLS（Row Level Security）
ALTER TABLE processing_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own logs"
  ON processing_logs FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Service role can insert"
  ON processing_logs FOR INSERT
  WITH CHECK (auth.uid() = user_id);
```

### 5.5 レート制限チェックロジック（Workers側）

```
1. JWTからuser_idを取得
2. Supabaseのuser_usageビューを参照
3. チェック:
   - today_count >= 5 → 「本日の上限に達しました。明日またお試しください」
   - month_count >= 50 → 「今月の上限に達しました」
   - active_count >= 1 → 「現在処理中の画像があります。完了後にお試しください」
4. パスしたら処理開始、processing_logsにINSERT（status='processing'）
5. 処理完了後、statusを'completed'に更新
```

---

## 6. Cloudflare R2 設計

### 6.1 バケット構造

```
bucket: image-processing-prod/
├── uploads/
│   └── {user_id}/
│       └── {uuid}.jpg          ← アップロード原画（1時間で自動削除）
├── results/
│   └── {user_id}/
│       └── {uuid}_processed.jpg ← 処理結果（1時間で自動削除）
└── demo/
    ├── before_1.jpg             ← LP用デモ画像（永続）
    ├── after_1.jpg
    └── ...
```

### 6.2 無料枠の使用量見積もり

```
R2無料枠:
  - ストレージ: 10GB/月
  - Class A操作（書き込み）: 1,000,000回/月
  - Class B操作（読み取り）: 10,000,000回/月
  - 送信（egress）: 無料（制限なし）

1画像あたりの使用量:
  - 入力: ~5MB
  - 出力: ~5MB
  - 合計: ~10MB
  - 操作: 2 Class A（書き込み×2） + 3 Class B（読み取り×3）

1時間で削除する場合:
  - 同時ストレージ最大: ~500MB（50枚同時）
  - 月間操作: 5,000枚 × 5操作 = 25,000回

→ 無料枠の1%未満。余裕。
```

### 6.3 ライフサイクルルール

```
uploads/ → 1時間後に自動削除
results/ → 1時間後に自動削除（将来、有料ユーザーは24時間に延長）
demo/    → 削除しない
```

---

## 7. Modal.com 設計

### 7.1 Modal Appの構成

```python
# modal_app.py（概要）

import modal

app = modal.App("image-processing")

# GPUコンテナの定義
image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "torch", "torchvision",
        "transformers",
        "opencv-python-headless",
        "numpy", "Pillow",
        "boto3",  # R2 (S3互換) アクセス用
    )
)

@app.cls(
    image=image,
    gpu="T4",
    timeout=300,
    container_idle_timeout=300,  # 5分間アイドルでコンテナ停止
    secrets=[modal.Secret.from_name("r2-credentials")],
)
class ImageProcessor:
    @modal.enter()
    def load_model(self):
        """コンテナ起動時にモデルをGPUに読み込み"""
        self.processor, self.model, self.device = load_face_parser()
        self.r2_client = create_r2_client()

    @modal.web_endpoint(method="POST")
    def process(self, request):
        """メインの処理エンドポイント"""
        # 1. R2から入力画像をダウンロード
        # 2. SegFormerでセグメンテーション
        # 3. マスク生成
        # 4. カラーグレーディング（Lift/Gamma/Offset）
        # 5. スキントーン保持
        # 6. 肌スムージング
        # 7. 結果をR2にアップロード
        # 8. 統計情報を返却

    @modal.web_endpoint(method="POST")
    def warmup(self):
        """プリウォームエンドポイント"""
        return {"status": "warm", "gpu": str(self.device)}
```

### 7.2 既存Pythonスクリプトからの移植

| 既存コード | Modal移植時の変更点 |
|-----------|-------------------|
| `face_segmentation.py` のメイン処理 | クラスメソッド化、ファイルI/OをR2に変更 |
| `load_face_parser()` | `@modal.enter()` でコンテナ起動時に1回だけ実行 |
| `segment_face()` | 変更なし（そのまま使用） |
| カラーグレーディング関数群 | 変更なし（そのまま使用） |
| EXIF/ICC保持 | Web用途のため簡略化（JPEGのみ、TIFF不要） |
| 入出力のファイルパス | R2のget/putに置換 |

移植の核心: **画像処理ロジック自体は1行も変更不要**。
変わるのはI/O（ローカルファイル → R2）とエントリーポイントのみ。

---

## 8. フロントエンド設計

### 8.1 技術スタック

| 技術 | 用途 | 選定理由 |
|------|------|---------|
| **Astro 5** | フレームワーク | LP（静的）+ ツール（動的）のハイブリッドに最適、未使用技術 |
| **React 19** | ツールUIのインタラクティブ部分 | Astro Islandとして使用 |
| **Tailwind CSS v4** | スタイリング | 慣れている + Astro対応 |
| **Supabase JS SDK** | 認証・DB | Auth + レート制限データ |
| **Cloudflare Pages** | ホスティング | 商用OK、R2連携、無料 |

### 8.2 ページ構成

```
/                      → LP（ランディングページ）
/login                 → ログイン/サインアップ
/app                   → ツール本体（認証必須）
/app/history           → 処理履歴（将来）
```

### 8.3 LP（ランディングページ）の構成

```
┌─────────────────────────────────────────┐
│ Hero                                    │
│ 「逆光写真を、プロ品質で自動補正」         │
│ [無料で試す] [デモを見る]                │
├─────────────────────────────────────────┤
│ Before/After デモ                       │
│ スライダーで比較できるインタラクティブUI  │
├─────────────────────────────────────────┤
│ 技術の特長（3つ）                        │
│ ① AIが顔をピクセル単位で認識            │
│ ② プロのカラリストと同じ補正手法         │
│ ③ 背景を1ピクセルも変えない精密さ       │
├─────────────────────────────────────────┤
│ 処理フロー（5ステップ図解）              │
│ SegFormer → マスク → Lift/Gamma/Offset  │
│ → スキントーン保持 → 完成               │
├─────────────────────────────────────────┤
│ 使い方（3ステップ）                      │
│ ① アップロード → ② 自動処理 → ③ DL     │
├─────────────────────────────────────────┤
│ 料金プラン                              │
│ 無料: 5枚/日  |  Pro: 50枚/日（将来）    │
├─────────────────────────────────────────┤
│ FAQ                                     │
├─────────────────────────────────────────┤
│ Footer                                  │
└─────────────────────────────────────────┘
```

### 8.4 ツール画面のUI

```
┌─────────────────────────────────────────┐
│ Header: ロゴ | 残り枚数: 3/5 | ログアウト │
├─────────────────────────────────────────┤
│                                         │
│  ┌─────────────────────────────────┐    │
│  │                                 │    │
│  │   ドラッグ&ドロップ              │    │
│  │   または クリックして選択         │    │
│  │                                 │    │
│  │   JPG, PNG  最大10MB            │    │
│  │   最大4000×4000px               │    │
│  │                                 │    │
│  └─────────────────────────────────┘    │
│                                         │
│  ↓ アップロード後                        │
│                                         │
│  ┌──────────────┬──────────────┐        │
│  │   Before     │   After      │        │
│  │              │              │        │
│  │  (元画像)    │ (処理結果)    │        │
│  │              │              │        │
│  │     ←───スライダー───→       │        │
│  └──────────────┴──────────────┘        │
│                                         │
│  処理統計:                               │
│  ・顔検出: 1人  ・輝度変化: +13.0        │
│  ・処理時間: 8.2秒                       │
│                                         │
│  [ダウンロード]  [別の画像を処理]          │
│                                         │
└─────────────────────────────────────────┘
```

---

## 9. セキュリティ

| 脅威 | 対策 |
|------|------|
| API不正利用 | JWT検証 + レート制限 |
| 大量アップロード攻撃 | ファイルサイズ制限（10MB）+ 同時処理1枚 |
| 不正な画像ファイル | Content-Type検証 + OpenCVの読み込み成功チェック |
| R2の直接アクセス | 署名付きURL（1時間有効）でのみアクセス |
| Modal APIの直接アクセス | シークレットキーでWorkersからのリクエストのみ受付 |
| 処理結果の漏洩 | ユーザーごとにディレクトリ分離 + RLS |

---

## 10. 技術的な新要素（ポートフォリオ価値）

このプロジェクトで新しく使う技術:

| 技術 | カテゴリ | 進捗管理の「次に試したい」リスト |
|------|---------|------------------------------|
| **Astro 5** | フレームワーク | リスト#8 |
| **Supabase (Auth + DB)** | BaaS | リスト#3 |
| **Python (Modal.com)** | バックエンド言語 | 使用技術一覧で「未使用」 |
| **Cloudflare R2** | ストレージ | 新規 |
| **Cloudflare Workers** | エッジAPI | リスト「未使用」 |
| **PyTorch / HuggingFace** | AI/ML | 新規 |

→ 1プロジェクトで6つの新技術。ポートフォリオとしてのインパクト大。

---

## 11. 開発フェーズ

### Phase 1: Modal.com バックエンド（1日目）
- [ ] Modal.comアカウント作成・セットアップ
- [ ] 既存PythonスクリプトをModalクラスに移植
- [ ] R2連携（boto3でS3互換アクセス）
- [ ] /process, /warmup エンドポイント実装
- [ ] ローカルテスト（modal serve）

### Phase 2: インフラ準備（1日目〜2日目）
- [ ] Cloudflare R2バケット作成・ライフサイクル設定
- [ ] Supabaseプロジェクト作成
- [ ] Supabase Auth設定（Email + Google OAuth）
- [ ] DBスキーマ作成（processing_logs, user_usage）
- [ ] R2アクセス用のAPIキー発行

### Phase 3: フロントエンド - LP（2日目〜3日目）
- [ ] Astroプロジェクト初期化（Cloudflare Pages adapter）
- [ ] LP実装（Hero, Before/After, 技術解説, 料金, FAQ）
- [ ] Before/Afterスライダーコンポーネント（React Island）
- [ ] レスポンシブ対応

### Phase 4: フロントエンド - ツール（3日目〜4日目）
- [ ] 認証フロー（ログイン/サインアップ画面）
- [ ] ツールページ（アップロードUI、プログレス表示）
- [ ] Cloudflare Workers API（JWT検証、レート制限、R2操作、Modal呼び出し）
- [ ] Before/After結果表示 + ダウンロード機能
- [ ] 残り枚数表示・エラーハンドリング

### Phase 5: 結合テスト・デプロイ（5日目）
- [ ] E2Eフロー確認（アップロード→処理→ダウンロード）
- [ ] コールドスタート時のUX確認
- [ ] レート制限の動作確認
- [ ] Cloudflare Pagesデプロイ
- [ ] Modal.comデプロイ（modal deploy）
- [ ] ドメイン設定（サブドメインまたはカスタム）

### Phase 6: 仕上げ（5日目〜6日目）
- [ ] OGP / SEO メタタグ
- [ ] エラー画面・404ページ
- [ ] ポートフォリオサイトからのリンク設定
- [ ] README作成

---

## 12. 将来の拡張（v2以降）

| 機能 | 概要 | 優先度 |
|------|------|--------|
| 有料プラン（Stripe） | 月額課金で枚数制限解除 | 中 |
| バッチ処理 | 複数枚一括アップロード | 中 |
| パラメータ調整UI | Lift/Gamma/Offsetスライダー | 低 |
| 処理履歴 | 過去の処理結果一覧 | 低 |
| 複数人対応 | 1枚に複数人が写っている場合の個別処理 | 低 |
| TIFF出力 | プロ向け無劣化出力 | 低 |

---

## 13. リスクと対策

| リスク | 影響 | 対策 |
|--------|------|------|
| Modal無料枠終了 | サービス停止 | 有料プラン導入 or Replicate移行 |
| コールドスタートが遅すぎる | UX悪化 | プリウォーム + 進捗UI + keep_warm検討 |
| 画像処理品質の問題 | ユーザー不満 | 既に実証済みのアルゴリズム使用 |
| アクセス集中 | Modal課金超過 | レート制限 + グローバル月間上限設定 |
| R2アクセスキー漏洩 | データ漏洩 | Workers内でのみ使用、フロント非公開 |
