import type { R2Bucket } from "@cloudflare/workers-types";

/**
 * Cloudflare R2 操作ヘルパー
 *
 * Cloudflare Pages Functions では、R2バケットは
 * env.R2_BUCKET として直接バインドされる（boto3不要）
 */

export interface R2Env {
  R2_BUCKET: R2Bucket;
}

export async function uploadToR2(
  bucket: R2Bucket,
  key: string,
  data: ArrayBuffer | ReadableStream,
  contentType: string
): Promise<void> {
  await bucket.put(key, data, {
    httpMetadata: { contentType },
  });
}

export async function getSignedUrl(
  bucket: R2Bucket,
  key: string
): Promise<string | null> {
  const obj = await bucket.get(key);
  if (!obj) return null;

  // R2 バインディングでは署名付きURLが直接生成できないため、
  // API経由でプロキシする方式を使用
  return `/api/download?key=${encodeURIComponent(key)}`;
}
