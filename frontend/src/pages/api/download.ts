import type { APIRoute } from "astro";
import { verifyAuth } from "../../lib/auth";
import { isValidR2Key, isUserAuthorizedForKey } from "../../lib/validation";

export const GET: APIRoute = async ({ request, locals }) => {
  try {
  // 認証チェック
  const auth = await verifyAuth(request, locals as CfLocals);
  if ("error" in auth) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const url = new URL(request.url);
  const key = url.searchParams.get("key");

  if (!key) {
    return new Response(JSON.stringify({ error: "key is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!isValidR2Key(key)) {
    return new Response(JSON.stringify({ error: "Invalid key format" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!isUserAuthorizedForKey(key, auth.userId)) {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const r2Bucket = (locals as CfLocals).runtime?.env?.R2_BUCKET;

  if (!r2Bucket) {
    return new Response(JSON.stringify({ error: "ストレージが設定されていません" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const object = await r2Bucket.get(key);
  if (!object) {
    return new Response(JSON.stringify({ error: "ファイルが見つかりません" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const headers = new Headers();
  headers.set(
    "Content-Type",
    object.httpMetadata?.contentType || "image/jpeg"
  );
  headers.set("Content-Disposition", `attachment; filename="face_brighten_result.jpg"`);
  headers.set("Cache-Control", "private, max-age=3600");

  return new Response(object.body, { headers });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "サーバーエラーが発生しました" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};
