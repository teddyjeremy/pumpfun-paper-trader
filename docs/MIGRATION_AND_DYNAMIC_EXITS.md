# Migration-aware position lifecycle and dynamic exits

This document supersedes the old rule that rejected all migrated tokens and the old 60-second / 300-second maximum-hold settings for open positions.

## State machine

DISCOVERED → CURVE_ACTIVE → ENTRY_PENDING → OPEN_CURVE

From OPEN_CURVE:

- Normal dynamic/protective exit → EXIT_PENDING → CLOSED.
- Graduation observed → MIGRATION_PENDING.
- Migrated pool verified and quoted → OPEN_MIGRATED.
- No verified migrated pool/quote → EXIT_BLOCKED (position remains open and is retried/alerted).

From OPEN_MIGRATED, use the same exit manager and transition to EXIT_PENDING → CLOSED. A migration event alone never transitions to CLOSED.

## Dynamic exit evidence

Track rolling windows at 2s, 5s, 10s, and 30s. Store quote-volume values separately from token counts and native-balance deltas. Measure:

- Buy/sell quote-volume ratio and net quote flow.
- Unique buyer/seller counts and rates.
- Buy-volume and buyer-rate change against the prior comparable window.
- Price change and price impact relative to net buying.
- Liquidity / real SOL reserves and executable sell quote.
- Creator, linked-wallet and high-concentration holder distribution.

A soft exhaustion exit requires at least two independent bearish evidence families in each of two or more consecutive complete windows. Correlated measurements are grouped so that, for example, a weak buy/sell ratio, net sell flow, and rising sell volume count as one order-flow family—not three independent votes. The families are: (1) order-flow pressure, (2) participation decay, (3) liquidity/reserve drain, (4) weakening price response to buy flow, and (5) large-holder distribution. A single low-volume or empty window is not enough. Do not count a missing provider window as zero buys. A verified critical creator/linked/high-confidence-cluster distribution event is an immediate emergency exit signal, subject to a fresh executable sell quote.

### Initial paper-calibration candidates (not locked strategy thresholds)

Test thresholds rather than silently selecting one. The dynamic exit engine groups these measurements into independent families and requires the configured family count in every confirmation window:

- Buy/sell ratio below 1.0, 1.2, or 1.5.
- Buy-volume decline of 30%, 40%, or 50% against the prior comparable window.
- Sell-volume increase of 50%, 75%, or 100% against the prior comparable window.
- Seller-rate increase of 50%, 75%, or 100% against the prior comparable window.
- Price response per unit of buy volume declining by 40%, 50%, or 60%.
- Large-holder net distribution thresholds calibrated separately from creator/linked-wallet emergency rules.
- Buyer-rate decline of 30%, 40%, or 50%.
- Confirmation over two or three consecutive windows.

Compare false exits, maximum adverse excursion, profit captured, post-exit continuation, and missed rug exits. The final threshold set must be versioned and explicitly approved before it becomes the production paper strategy.

## Protective exits retained

- Hard stop -5%.
- Trailing activates at +10% and follows 40% below the highest completed observation.
- Profit locks: +5% after +10% achieved; +15% after +50%; +40% after +100%; +80% after +200%.
- Stop level is monotonic and cannot move down.
- No maximum holding duration.

## Migration rules

- Graduation is an event/state change only.
- Verify the migrated pool by mint, pool program, token pair, and on-chain account state.
- Obtain a fresh quote for the complete paper position, including fees, impact and slippage.
- Do not assume the bonding-curve price equals the migrated pool price.
- Do not automatically route to an arbitrary DEX. Only explicitly enabled, verified venues may be used.
- If the market is temporarily unavailable, keep the position open as EXIT_BLOCKED, show its last verified mark with a stale-data label, alert, and retry. Do not invent a fill or mark the position closed.
- If a valid route returns, resume the exit manager immediately.

## Ledger requirements

Every migration and exit observation must persist:

- Mint, position ID, prior/new market state, slot and timestamp.
- Pool address/program and verification evidence.
- Quote input/output amounts and context slot.
- Fee/impact/slippage breakdown and quote freshness.
- Window features and dynamic exit signals.
- Exit decision, reason, and whether a valid quote existed.

A portfolio slot is released only after the paper sell is confirmed by a valid quote/fill record and token balance is zero.
