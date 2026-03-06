/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_SUPABASE_URL: string;
  readonly PUBLIC_SUPABASE_ANON_KEY: string;
  readonly SUPABASE_URL: string;
  readonly SUPABASE_SERVICE_ROLE_KEY: string;
  readonly MODAL_PROCESS_URL: string;
  readonly MODAL_WARMUP_URL: string;
  readonly MODAL_API_SECRET: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
