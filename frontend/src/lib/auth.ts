import { createClient } from "@supabase/supabase-js";

/**
 * サーバーサイドで使うSupabaseクライアント（Service Role）
 * APIエンドポイントでJWT検証やDB操作に使用
 */
export function createServerSupabase() {
  return createClient(
    import.meta.env.SUPABASE_URL,
    import.meta.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

/**
 * AuthorizationヘッダーからJWTを検証し、ユーザーIDを取得
 */
export async function verifyAuth(
  request: Request
): Promise<{ userId: string } | { error: string; status: number }> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { error: "認証が必要です", status: 401 };
  }

  const token = authHeader.slice(7);
  const supabase = createServerSupabase();

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token);

  if (error || !user) {
    return { error: "無効な認証トークンです", status: 401 };
  }

  return { userId: user.id };
}
