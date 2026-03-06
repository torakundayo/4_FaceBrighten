import type { APIRoute } from "astro";
import { verifyAuth, createServerSupabase } from "../../lib/auth";

const DAILY_LIMIT = 5;
const MONTHLY_LIMIT = 50;

export const GET: APIRoute = async ({ request }) => {
  const auth = await verifyAuth(request);
  if ("error" in auth) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabase = createServerSupabase();

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
