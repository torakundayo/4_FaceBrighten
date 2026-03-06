// 許可する画像フォーマットのマジックバイト
const IMAGE_SIGNATURES: { mime: string; bytes: number[] }[] = [
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: "image/webp", bytes: [0x52, 0x49, 0x46, 0x46] }, // "RIFF"
];

export function detectImageType(buffer: ArrayBuffer): string | null {
  const header = new Uint8Array(buffer, 0, 12);
  for (const sig of IMAGE_SIGNATURES) {
    if (sig.bytes.every((b, i) => header[i] === b)) {
      // WebP は追加チェック: offset 8-11 が "WEBP"
      if (sig.mime === "image/webp") {
        if (header[8] !== 0x57 || header[9] !== 0x45 || header[10] !== 0x42 || header[11] !== 0x50) {
          continue;
        }
      }
      return sig.mime;
    }
  }
  return null;
}

export function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message;
    if (msg.includes("Modal") || msg.includes("R2") || msg.includes("fetch") || msg.includes("ECONNREFUSED")) {
      return "画像処理サーバーに接続できませんでした。しばらく待ってからお試しください";
    }
    if (msg.includes("Unauthorized")) {
      return "画像処理サーバーの認証に失敗しました";
    }
    if (msg.startsWith("本日の") || msg.startsWith("今月の") || msg.startsWith("現在処理中")) {
      return msg;
    }
  }
  return "画像処理に失敗しました";
}

export function getAllowedOrigins(envOrigins?: string): string[] {
  if (envOrigins) {
    return envOrigins.split(",").map((o) => o.trim());
  }
  return [
    "https://4-facebrighten.pages.dev",
    "http://localhost:4321",
    "http://localhost:8788",
  ];
}

// R2キーのフォーマット検証
export const R2_KEY_PATTERN = /^(uploads|results)\/[0-9a-f\-]{36}\/[0-9a-f\-]{36}(_processed)?\.(jpg|jpeg|png)$/;

export function isValidR2Key(key: string): boolean {
  return R2_KEY_PATTERN.test(key);
}

export function isUserAuthorizedForKey(key: string, userId: string): boolean {
  const allowedPrefixes = [
    `uploads/${userId}/`,
    `results/${userId}/`,
  ];
  return allowedPrefixes.some((prefix) => key.startsWith(prefix));
}
