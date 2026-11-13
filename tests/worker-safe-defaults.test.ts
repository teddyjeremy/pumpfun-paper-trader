import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Cloudflare Worker approved wallet-history budget", () => {
  it("enables only the approved two-page wallet-history collection cap", () => {
    const config = JSON.parse(
      readFileSync(new URL("../infra/cloudflare/worker/wrangler.jsonc", import.meta.url), "utf8")
    ) as { vars?: Record<string, string> };

    expect(config.vars?.FULL_WALLET_HISTORY_ENABLED).toBe("true");
    expect(config.vars?.FULL_WALLET_HISTORY_MAX_PAGES).toBe("2");
  });
});
