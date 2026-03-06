import type { APIRoute } from "astro";
import { verifyAuth, createServerSupabase } from "../../lib/auth";
import { DAILY_LIMIT, MONTHLY_LIMIT, PROCESSING_TIMEOUT_MIN, LOG_RETENTION_DAYS } from "../../lib/constants";

export const GET: APIRoute = async ({ request }) => {
  const auth = await verifyAuth(request);
  if ("error" in auth) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabase = createServerSupabase();

  // processing状態のタイムアウト復旧（全ユーザー対象: 5分以上前のprocessingをfailedに変更）
  const timeoutCutoff = new Date();
  timeoutCutoff.setMinutes(timeoutCutoff.getMinutes() - PROCESSING_TIMEOUT_MIN);
  supabase
    .from("processing_logs")
    .update({ status: "failed" })
    .eq("status", "processing")
    .lt("created_at", timeoutCutoff.toISOString())
    .then(() => {});

  // 古いログの自動クリーンアップ（全ユーザー対象: 30日以上前のレコードを削除）
  const retentionCutoff = new Date();
  retentionCutoff.setDate(retentionCutoff.getDate() - LOG_RETENTION_DAYS);
  supabase
    .from("processing_logs")
    .delete()
    .lt("created_at", retentionCutoff.toISOString())
    .then(() => {});

  // 今日の使用回数
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const { count: todayCount } = await supabase
    .from("processing_logs")
    .select("*", { count: "exact", head: true })
    .eq("user_id", auth.userId)
    .gte("created_at", todayStart.toISOString())
    .in("status", ["completed", "processing"]);

  // 今月の使用回数
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const { count: monthCount } = await supabase
    .from("processing_logs")
    .select("*", { count: "exact", head: true })
    .eq("user_id", auth.userId)
    .gte("created_at", monthStart.toISOString())
    .in("status", ["completed", "processing"]);

  return new Response(
    JSON.stringify({
      today_count: todayCount ?? 0,
      month_count: monthCount ?? 0,
      daily_limit: DAILY_LIMIT,
      monthly_limit: MONTHLY_LIMIT,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
};
