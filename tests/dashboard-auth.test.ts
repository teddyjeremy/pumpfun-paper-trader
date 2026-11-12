import { describe, expect, it } from "vitest";
import { authorizeDashboardRequest } from "../src/dashboard-auth.js";

describe("read-only dashboard authentication", () => {
  const username = "operator";
  const password = "a-long-test-secret";

  it("accepts valid HTTP Basic credentials", () => {
    const authorization = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
    expect(authorizeDashboardRequest({ authorization, username, password, production: true })).toBe("ALLOW");
  });

  it("rejects missing, malformed and incorrect credentials", () => {
    expect(authorizeDashboardRequest({ authorization: null, username, password, production: true })).toBe("UNAUTHORIZED");
    expect(authorizeDashboardRequest({ authorization: "Bearer token", username, password, production: true })).toBe("UNAUTHORIZED");
    const wrong = "Basic " + Buffer.from(`${username}:wrong`).toString("base64");
    expect(authorizeDashboardRequest({ authorization: wrong, username, password, production: true })).toBe("UNAUTHORIZED");
  });

  it("fails closed in production when credentials are not configured", () => {
    expect(authorizeDashboardRequest({ authorization: null, username: "", password: "", production: true })).toBe("NOT_CONFIGURED");
  });

  it("keeps local development usable when dashboard credentials are omitted", () => {
    expect(authorizeDashboardRequest({ authorization: null, username: "", password: "", production: false })).toBe("ALLOW");
  });
});
