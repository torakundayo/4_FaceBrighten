/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_SUPABASE_URL: string;
  readonly PUBLIC_SUPABASE_ANON_KEY: string;
  readonly SUPABASE_URL: string;
  readonly SUPABASE_SERVICE_ROLE_KEY: string;
  readonly MODAL_PROCESS_URL: string;
  readonly MODAL_WARMUP_URL: string;
  readonly MODAL_API_SECRET: string;
  readonly ALLOWED_ORIGINS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Cloudflare Bindings
interface CfR2Object {
  body: ReadableStream;
  httpMetadata?: { contentType?: string };
}

interface CfR2Bucket {
  get(key: string): Promise<CfR2Object | null>;
  put(key: string, value: ArrayBuffer | ReadableStream, options?: { httpMetadata?: { contentType?: string } }): Promise<void>;
  delete(key: string): Promise<void>;
}

interface CfEnv {
  R2_BUCKET: CfR2Bucket;
}

interface CfRuntime {
  env: CfEnv;
}

interface CfLocals {
  runtime?: CfRuntime;
}
