import { describe, it, expect } from "vitest";
import { DAILY_LIMIT, MONTHLY_LIMIT, PROCESSING_TIMEOUT_MIN, LOG_RETENTION_DAYS } from "./constants";

describe("constants", () => {
  it("has reasonable daily limit", () => {
    expect(DAILY_LIMIT).toBeGreaterThan(0);
    expect(DAILY_LIMIT).toBeLessThanOrEqual(100);
  });

  it("monthly limit is greater than daily limit", () => {
    expect(MONTHLY_LIMIT).toBeGreaterThan(DAILY_LIMIT);
  });

  it("processing timeout is positive", () => {
    expect(PROCESSING_TIMEOUT_MIN).toBeGreaterThan(0);
  });

  it("log retention is at least 1 day", () => {
    expect(LOG_RETENTION_DAYS).toBeGreaterThanOrEqual(1);
  });
});
