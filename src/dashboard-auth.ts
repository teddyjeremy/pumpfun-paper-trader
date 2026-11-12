import { timingSafeEqual } from "node:crypto";

export type DashboardAuthResult = "ALLOW" | "UNAUTHORIZED" | "NOT_CONFIGURED";

export function authorizeDashboardRequest(input: {
  authorization: string | null;
  username: string;
  password: string;
  production: boolean;
}): DashboardAuthResult {
  if (!input.username || !input.password) {
    return input.production ? "NOT_CONFIGURED" : "ALLOW";
  }
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/.exec(input.authorization ?? "");
  if (!match?.[1]) return "UNAUTHORIZED";
  const supplied = Buffer.from(match[1], "base64");
  if (supplied.toString("base64") !== match[1]) return "UNAUTHORIZED";
  const expected = Buffer.from(`${input.username}:${input.password}`, "utf8");
  if (supplied.length !== expected.length) return "UNAUTHORIZED";
  return timingSafeEqual(supplied, expected) ? "ALLOW" : "UNAUTHORIZED";
}
