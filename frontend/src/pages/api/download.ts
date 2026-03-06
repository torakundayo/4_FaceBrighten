import type { APIRoute } from "astro";
import { verifyAuth } from "../../lib/auth";

export const GET: APIRoute = async ({ request, locals }) => {
  // 認証チェック
  const auth = await verifyAuth(request);
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

  // ユーザーが自分のファイルのみアクセスできるようにチェック
  if (!key.includes(auth.userId)) {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const env = (locals as any).runtime?.env;
  const r2Bucket = env?.R2_BUCKET;

  if (!r2Bucket) {
    return new Response(JSON.stringify({ error: "R2 not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const object = await r2Bucket.get(key);
  if (!object) {
    return new Response(JSON.stringify({ error: "File not found" }), {
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
};
