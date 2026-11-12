import { describe, expect, it } from "vitest";
import { isStrongServiceToken, MIN_SERVICE_TOKEN_LENGTH } from "../src/service-token.js";

describe("service-to-service token strength", () => {
  it("accepts tokens at or above the minimum length", () => {
    expect(isStrongServiceToken("x".repeat(MIN_SERVICE_TOKEN_LENGTH))).toBe(true);
    expect(isStrongServiceToken("x".repeat(MIN_SERVICE_TOKEN_LENGTH + 1))).toBe(true);
  });

  it("rejects missing and undersized tokens", () => {
    expect(isStrongServiceToken(undefined)).toBe(false);
    expect(isStrongServiceToken(null)).toBe(false);
    expect(isStrongServiceToken("")).toBe(false);
    expect(isStrongServiceToken("x".repeat(MIN_SERVICE_TOKEN_LENGTH - 1))).toBe(false);
  });
});
