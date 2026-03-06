import type { APIRoute } from "astro";
import { verifyAuth } from "../../lib/auth";

export const POST: APIRoute = async ({ request, locals }) => {
  // 認証チェック（未認証ユーザーによるGPUコスト攻撃を防止）
  const cfLocals = locals as CfLocals;
  const auth = await verifyAuth(request, cfLocals);
  if ("error" in auth) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const modalUrl = cfLocals.runtime?.env?.MODAL_WARMUP_URL || import.meta.env.MODAL_WARMUP_URL;
  if (!modalUrl) {
    return new Response(JSON.stringify({ status: "skipped" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const res = await fetch(modalUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return new Response(JSON.stringify({ status: "warmup_failed" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
};
