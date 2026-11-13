import { describe, expect, it } from "vitest";
import {
  MAX_FULL_WALLET_HISTORY_PAGES,
  MAX_FULL_WALLET_HISTORY_WALLETS,
  normalizeFullWalletHistoryMaxPages,
  selectFullWalletHistoryScope
} from "../src/ingestion/full-wallet-history-budget.js";

describe("approved full wallet history budget", () => {
  it("caps collection at 16 wallets and marks a truncated wallet set incomplete", () => {
    const wallets = Array.from({ length: 20 }, (_, index) => `wallet-${index}`);
    const expected = Object.fromEntries(wallets.map(wallet => [wallet, [`sig-${wallet}`]]));
    const scope = selectFullWalletHistoryScope(wallets, expected, true);

    expect(scope.wallets).toHaveLength(MAX_FULL_WALLET_HISTORY_WALLETS);
    expect(scope.wallets).toEqual(wallets.slice(0, 16));
    expect(Object.keys(scope.expectedSignaturesByWallet)).toHaveLength(16);
    expect(scope.walletSetVerifiedComplete).toBe(false);
  });

  it("allows a complete wallet set when it fits within the cap", () => {
    const scope = selectFullWalletHistoryScope(["wallet-a", "wallet-b"], {
      "wallet-a": ["sig-a"],
      "wallet-b": ["sig-b"]
    }, true);

    expect(scope.walletSetVerifiedComplete).toBe(true);
    expect(scope.expectedSignaturesByWallet["wallet-b"]).toEqual(["sig-b"]);
  });

  it("never allows the configured page cap to exceed two", () => {
    expect(normalizeFullWalletHistoryMaxPages("2")).toBe(MAX_FULL_WALLET_HISTORY_PAGES);
    expect(normalizeFullWalletHistoryMaxPages("5")).toBe(2);
    expect(normalizeFullWalletHistoryMaxPages("0")).toBe(2);
    expect(normalizeFullWalletHistoryMaxPages("not-a-number")).toBe(2);
  });
});
