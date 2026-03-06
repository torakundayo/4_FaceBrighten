import { createClient } from "@supabase/supabase-js";

/**
 * Cloudflare Pages ランタイム環境変数を取得するヘルパー
 * runtime.env → import.meta.env のフォールバック付き
 */
function getRuntimeEnv(locals: CfLocals, key: keyof CfEnv): string {
  const val = locals.runtime?.env?.[key] as unknown as string | undefined;
  return val || (import.meta.env as Record<string, string>)[key] || "";
}

/**
 * サーバーサイドで使うSupabaseクライアント（Service Role）
 * APIエンドポイントでJWT検証やDB操作に使用
 */
export function createServerSupabase(locals: CfLocals) {
  const url = getRuntimeEnv(locals, "SUPABASE_URL");
  const key = getRuntimeEnv(locals, "SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("Supabase credentials not configured");
  }
  return createClient(url, key);
}

/**
 * AuthorizationヘッダーからJWTを検証し、ユーザーIDを取得
 */
export async function verifyAuth(
  request: Request,
  locals: CfLocals
): Promise<{ userId: string } | { error: string; status: number }> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { error: "認証が必要です", status: 401 };
  }

  const token = authHeader.slice(7);
  const supabase = createServerSupabase(locals);

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token);

  if (error || !user) {
    return { error: "無効な認証トークンです", status: 401 };
  }

  return { userId: user.id };
}
