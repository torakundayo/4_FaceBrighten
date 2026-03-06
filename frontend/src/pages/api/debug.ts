import type { APIRoute } from "astro";

export const GET: APIRoute = async ({ locals }) => {
  const runtime = (locals as CfLocals).runtime;

  const check = (name: string, value: unknown) =>
    value ? `OK (${String(value).slice(0, 8)}...)` : "MISSING";

  const result = {
    env_via_import_meta: {
      SUPABASE_URL: check("SUPABASE_URL", import.meta.env.SUPABASE_URL),
      SUPABASE_SERVICE_ROLE_KEY: check("SUPABASE_SERVICE_ROLE_KEY", import.meta.env.SUPABASE_SERVICE_ROLE_KEY),
      MODAL_PROCESS_URL: check("MODAL_PROCESS_URL", import.meta.env.MODAL_PROCESS_URL),
      MODAL_WARMUP_URL: check("MODAL_WARMUP_URL", import.meta.env.MODAL_WARMUP_URL),
      MODAL_API_SECRET: check("MODAL_API_SECRET", import.meta.env.MODAL_API_SECRET),
      PUBLIC_SUPABASE_URL: check("PUBLIC_SUPABASE_URL", import.meta.env.PUBLIC_SUPABASE_URL),
      PUBLIC_SUPABASE_ANON_KEY: check("PUBLIC_SUPABASE_ANON_KEY", import.meta.env.PUBLIC_SUPABASE_ANON_KEY),
    },
    runtime_available: !!runtime,
    runtime_env_keys: runtime?.env ? Object.keys(runtime.env) : [],
    r2_bucket_available: !!(runtime?.env as Record<string, unknown>)?.R2_BUCKET,
  };

  return new Response(JSON.stringify(result, null, 2), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
