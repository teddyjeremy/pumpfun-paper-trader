import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    server: {
      deps: { inline: ["@pump-fun/pump-sdk", "@pump-fun/agent-payments-sdk"] }
    }
  },
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(new URL("./tests/support/cloudflare-workers.ts", import.meta.url))
    }
  }
});
