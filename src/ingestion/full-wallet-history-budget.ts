export const MAX_FULL_WALLET_HISTORY_WALLETS = 16;
export const MAX_FULL_WALLET_HISTORY_PAGES = 2;

export interface FullWalletHistoryScope {
  wallets: string[];
  expectedSignaturesByWallet: Record<string, string[]>;
  walletSetVerifiedComplete: boolean;
}

export function selectFullWalletHistoryScope(
  wallets: readonly string[],
  expectedSignaturesByWallet: Readonly<Record<string, string[]>>,
  walletSetVerifiedComplete: boolean
): FullWalletHistoryScope {
  const selectedWallets = [...wallets].slice(0, MAX_FULL_WALLET_HISTORY_WALLETS);
  return {
    wallets: selectedWallets,
    expectedSignaturesByWallet: Object.fromEntries(selectedWallets.map(wallet => [
      wallet, [...(expectedSignaturesByWallet[wallet] ?? [])]
    ])),
    walletSetVerifiedComplete: walletSetVerifiedComplete &&
      wallets.length <= MAX_FULL_WALLET_HISTORY_WALLETS
  };
}

export function normalizeFullWalletHistoryMaxPages(value: string | undefined): number {
  const parsed = Number(value ?? String(MAX_FULL_WALLET_HISTORY_PAGES));
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAX_FULL_WALLET_HISTORY_PAGES
    ? parsed
    : MAX_FULL_WALLET_HISTORY_PAGES;
}
