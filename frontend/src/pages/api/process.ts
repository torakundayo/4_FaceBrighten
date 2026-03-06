import type { APIRoute } from "astro";
import { verifyAuth, createServerSupabase } from "../../lib/auth";
import { DAILY_LIMIT, MONTHLY_LIMIT } from "../../lib/constants";
import { detectImageType, safeErrorMessage, getAllowedOrigins } from "../../lib/validation";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export const POST: APIRoute = async ({ request, locals }) => {
  // CSRF保護: Origin/Refererヘッダーの検証
  const origin = request.headers.get("Origin") || request.headers.get("Referer") || "";
  const allowedOrigins = getAllowedOrigins(import.meta.env.ALLOWED_ORIGINS);
  if (!allowedOrigins.some((o) => origin.startsWith(o))) {
    return jsonResponse({ error: "Forbidden" }, 403);
  }

  // 1. 認証チェック
  const auth = await verifyAuth(request);
  if ("error" in auth) {
    return jsonResponse({ error: auth.error }, auth.status);
  }

  const supabase = createServerSupabase();

  // 2. レート制限チェック + ロック（競合状態対策）
  // まず processing ステータスのレコードを先に挿入して排他制御
  // activeCount チェックで同時実行を防止
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const [{ count: todayCount }, { count: monthCount }, { count: activeCount }] =
    await Promise.all([
      supabase
        .from("processing_logs")
        .select("*", { count: "exact", head: true })
        .eq("user_id", auth.userId)
        .gte("created_at", todayStart.toISOString())
        .in("status", ["completed", "processing"]),
      supabase
        .from("processing_logs")
        .select("*", { count: "exact", head: true })
        .eq("user_id", auth.userId)
        .gte("created_at", monthStart.toISOString())
        .in("status", ["completed", "processing"]),
      supabase
        .from("processing_logs")
        .select("*", { count: "exact", head: true })
        .eq("user_id", auth.userId)
        .eq("status", "processing"),
    ]);

  if ((todayCount ?? 0) >= DAILY_LIMIT) {
    return jsonResponse(
      { error: `本日の処理上限（${DAILY_LIMIT}枚）に達しました` },
      429
    );
  }
  if ((monthCount ?? 0) >= MONTHLY_LIMIT) {
    return jsonResponse(
      { error: `今月の処理上限（${MONTHLY_LIMIT}枚）に達しました` },
      429
    );
  }
  if ((activeCount ?? 0) >= 1) {
    return jsonResponse(
      { error: "現在処理中の画像があります。完了後にお試しください" },
      429
    );
  }

  // 3. 画像データの取得
  const formData = await request.formData();
  const file = formData.get("image") as File | null;

  if (!file) {
    return jsonResponse({ error: "画像ファイルが必要です" }, 400);
  }
  if (file.size > MAX_FILE_SIZE) {
    return jsonResponse({ error: "ファイルサイズは10MB以下にしてください" }, 400);
  }
  if (!file.type.startsWith("image/")) {
    return jsonResponse({ error: "画像ファイルを選択してください" }, 400);
  }

  // マジックバイトによる実際のファイル形式検証
  const imageBuffer = await file.arrayBuffer();
  const detectedType = detectImageType(imageBuffer);
  if (!detectedType) {
    return jsonResponse({ error: "対応していない画像形式です。JPG, PNG, WebP のみ対応しています" }, 400);
  }

  // 4. processing_logs に先に記録（競合状態対策: 先にロックを取る）
  const uuid = crypto.randomUUID();
  const ext = detectedType === "image/png" ? ".png" : ".jpg";
  const inputKey = `uploads/${auth.userId}/${uuid}${ext}`;

  const { data: log, error: insertError } = await supabase
    .from("processing_logs")
    .insert({
      user_id: auth.userId,
      status: "processing",
      input_key: inputKey,
      file_size: file.size,
    })
    .select()
    .single();

  if (insertError) {
    // INSERT失敗 = 競合状態で他のリクエストが先にprocessingレコードを作成した可能性
    return jsonResponse(
      { error: "現在処理中の画像があります。完了後にお試しください" },
      429
    );
  }

  // 5. R2にアップロード
  const r2Bucket = (locals as CfLocals).runtime?.env?.R2_BUCKET;

  if (!r2Bucket) {
    await supabase
      .from("processing_logs")
      .update({ status: "failed" })
      .eq("id", log.id);
    return jsonResponse(
      { error: "ストレージが設定されていません" },
      500
    );
  }

  await r2Bucket.put(inputKey, imageBuffer, {
    httpMetadata: { contentType: detectedType },
  });

  // 6. Modal API 呼び出し
  const modalUrl = import.meta.env.MODAL_PROCESS_URL;
  const apiSecret = import.meta.env.MODAL_API_SECRET;

  try {
    const modalRes = await fetch(modalUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input_key: inputKey,
        api_secret: apiSecret,
      }),
    });

    if (!modalRes.ok) {
      const errData = await modalRes.json().catch(() => ({}));
      throw new Error(errData.error || "Processing failed");
    }

    const result = await modalRes.json();

    // 7. processing_logs を更新（mask_imageはサイズが大きいのでDBには保存しない）
    const { mask_image, ...statsForDb } = result.stats ?? {};
    await supabase
      .from("processing_logs")
      .update({
        status: result.stats?.face_detected ? "completed" : "failed",
        result_key: result.result_key,
        process_sec: result.process_sec,
        stats: statsForDb,
      })
      .eq("id", log.id);

    // 8. ダウンロードURL生成
    const downloadUrl = result.result_key
      ? `/api/download?key=${encodeURIComponent(result.result_key)}`
      : null;

    return jsonResponse({
      download_url: downloadUrl,
      stats: result.stats,
      process_sec: result.process_sec,
    });
  } catch (err) {
    // エラー時: ログを failed に更新
    await supabase
      .from("processing_logs")
      .update({ status: "failed" })
      .eq("id", log.id);

    return jsonResponse(
      { error: safeErrorMessage(err) },
      500
    );
  }
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
