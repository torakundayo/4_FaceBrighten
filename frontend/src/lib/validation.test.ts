import { describe, it, expect } from "vitest";
import {
  detectImageType,
  safeErrorMessage,
  getAllowedOrigins,
  isValidR2Key,
  isUserAuthorizedForKey,
} from "./validation";

describe("detectImageType", () => {
  it("detects JPEG", () => {
    const buf = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]).buffer;
    expect(detectImageType(buf)).toBe("image/jpeg");
  });

  it("detects PNG", () => {
    const buf = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).buffer;
    expect(detectImageType(buf)).toBe("image/png");
  });

  it("detects WebP", () => {
    // RIFF....WEBP
    const buf = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]).buffer;
    expect(detectImageType(buf)).toBe("image/webp");
  });

  it("rejects invalid RIFF (not WebP)", () => {
    const buf = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20]).buffer;
    expect(detectImageType(buf)).toBeNull();
  });

  it("rejects unknown format", () => {
    const buf = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]).buffer;
    expect(detectImageType(buf)).toBeNull();
  });

  it("rejects empty buffer", () => {
    const buf = new Uint8Array(12).buffer;
    expect(detectImageType(buf)).toBeNull();
  });
});

describe("safeErrorMessage", () => {
  it("hides Modal internal errors", () => {
    expect(safeErrorMessage(new Error("Modal connection refused"))).toBe(
      "画像処理サーバーに接続できませんでした。しばらく待ってからお試しください"
    );
  });

  it("hides R2 errors", () => {
    expect(safeErrorMessage(new Error("R2 bucket not found"))).toBe(
      "画像処理サーバーに接続できませんでした。しばらく待ってからお試しください"
    );
  });

  it("hides fetch errors", () => {
    expect(safeErrorMessage(new Error("fetch failed"))).toBe(
      "画像処理サーバーに接続できませんでした。しばらく待ってからお試しください"
    );
  });

  it("hides ECONNREFUSED", () => {
    expect(safeErrorMessage(new Error("ECONNREFUSED 127.0.0.1:443"))).toBe(
      "画像処理サーバーに接続できませんでした。しばらく待ってからお試しください"
    );
  });

  it("shows auth error message", () => {
    expect(safeErrorMessage(new Error("Unauthorized"))).toBe(
      "画像処理サーバーの認証に失敗しました"
    );
  });

  it("passes through known user-facing messages", () => {
    expect(safeErrorMessage(new Error("本日の処理上限に達しました"))).toBe("本日の処理上限に達しました");
    expect(safeErrorMessage(new Error("今月の上限です"))).toBe("今月の上限です");
    expect(safeErrorMessage(new Error("現在処理中です"))).toBe("現在処理中です");
  });

  it("returns generic message for unknown errors", () => {
    expect(safeErrorMessage(new Error("something unexpected"))).toBe("画像処理に失敗しました");
    expect(safeErrorMessage("string error")).toBe("画像処理に失敗しました");
    expect(safeErrorMessage(null)).toBe("画像処理に失敗しました");
    expect(safeErrorMessage(undefined)).toBe("画像処理に失敗しました");
  });
});

describe("getAllowedOrigins", () => {
  it("returns defaults when no env var", () => {
    const origins = getAllowedOrigins();
    expect(origins).toEqual([
      "https://face-brighten.pages.dev",
      "http://localhost:4321",
      "http://localhost:8788",
    ]);
  });

  it("returns defaults for undefined", () => {
    expect(getAllowedOrigins(undefined)).toEqual(getAllowedOrigins());
  });

  it("parses comma-separated env var", () => {
    const origins = getAllowedOrigins("https://custom.example.com,https://other.example.com");
    expect(origins).toEqual(["https://custom.example.com", "https://other.example.com"]);
  });

  it("trims whitespace", () => {
    const origins = getAllowedOrigins("  https://a.com , https://b.com  ");
    expect(origins).toEqual(["https://a.com", "https://b.com"]);
  });
});

describe("isValidR2Key", () => {
  const validUuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

  it("accepts valid upload key", () => {
    expect(isValidR2Key(`uploads/${validUuid}/${validUuid}.jpg`)).toBe(true);
    expect(isValidR2Key(`uploads/${validUuid}/${validUuid}.jpeg`)).toBe(true);
    expect(isValidR2Key(`uploads/${validUuid}/${validUuid}.png`)).toBe(true);
  });

  it("accepts valid result key", () => {
    expect(isValidR2Key(`results/${validUuid}/${validUuid}_processed.jpg`)).toBe(true);
  });

  it("rejects path traversal", () => {
    expect(isValidR2Key(`uploads/../etc/passwd`)).toBe(false);
    expect(isValidR2Key(`uploads/${validUuid}/../../secret.jpg`)).toBe(false);
  });

  it("rejects invalid prefix", () => {
    expect(isValidR2Key(`other/${validUuid}/${validUuid}.jpg`)).toBe(false);
  });

  it("rejects invalid extension", () => {
    expect(isValidR2Key(`uploads/${validUuid}/${validUuid}.exe`)).toBe(false);
    expect(isValidR2Key(`uploads/${validUuid}/${validUuid}.svg`)).toBe(false);
  });

  it("rejects empty or malformed keys", () => {
    expect(isValidR2Key("")).toBe(false);
    expect(isValidR2Key("uploads/")).toBe(false);
    expect(isValidR2Key("uploads/not-a-uuid/file.jpg")).toBe(false);
  });
});

describe("isUserAuthorizedForKey", () => {
  const userId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
  const otherUserId = "00000000-0000-0000-0000-000000000000";
  const fileUuid = "11111111-2222-3333-4444-555555555555";

  it("allows user to access their own uploads", () => {
    expect(isUserAuthorizedForKey(`uploads/${userId}/${fileUuid}.jpg`, userId)).toBe(true);
  });

  it("allows user to access their own results", () => {
    expect(isUserAuthorizedForKey(`results/${userId}/${fileUuid}_processed.jpg`, userId)).toBe(true);
  });

  it("denies access to another user's files", () => {
    expect(isUserAuthorizedForKey(`uploads/${otherUserId}/${fileUuid}.jpg`, userId)).toBe(false);
    expect(isUserAuthorizedForKey(`results/${otherUserId}/${fileUuid}_processed.jpg`, userId)).toBe(false);
  });

  it("denies access when userId is embedded but not as prefix", () => {
    // userId appears in the path but not as the correct prefix segment
    expect(isUserAuthorizedForKey(`uploads/x${userId}/${fileUuid}.jpg`, userId)).toBe(false);
  });
});
