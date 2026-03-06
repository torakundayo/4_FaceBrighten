import type { APIRoute } from "astro";

export const POST: APIRoute = async () => {
  const modalUrl = import.meta.env.MODAL_WARMUP_URL;
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
