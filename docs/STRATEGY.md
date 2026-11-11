# Trading strategy v1 — strict entry, adaptive exit

Status: paper-trading specification. The standard strategy is the only enabled strategy. The experimental concentrated-flow entry path is excluded.

## Scope and mode

- Pump.fun bonding-curve launches only at entry.
- A token must be non-migrated when the entry decision is made.
- Paper execution only. No wallet key, transaction signing, or on-chain submission.
- All decisions use source timestamps and slots. Missing or stale critical evidence fails closed.
- Every decision records the strategy version, configuration hash, source slot, observation time, and rejection reasons.

## Entry — all conditions are mandatory

### Price formation

1. Observe the first 60 seconds after launch.
2. Price impulse reaches at least +20%.
3. Price pulls back 10–40% from the impulse high.
4. Reclaim reaches at least +1% above the previous completed five-second high.
5. The candidate signal is 1–2 seconds old and is confirmed again on the next observation.

### Flow confirmation

Use three consecutive two-second windows. Every window must have:

- Buy/sell quote-volume ratio strictly greater than 3:1.
- At least three unique buyers.
- Sellers no greater than half the buyer count.

Across the three windows:

- At least five distinct buyers.
- Largest buyer share no greater than 72% of total buy quote volume.

Also persist and evaluate the complete impulse, pullback, pullback-low, and reclaim volume profile. The original strategy has not yet established numerical thresholds for pullback-volume contraction or reclaim-volume expansion. Do not silently invent thresholds or use the experimental concentrated-flow values. Until the required measurements can be calculated from reliable quote-volume data, mark the candidate WATCH / NOT READY rather than BUY.

### Creator, wallet and cluster safety

Reject if any of the following is verified:

- Creator sells more than 0.05% of supply in the first 60 seconds.
- Creator-linked wallets sell more than 0.25% of supply.
- A high-confidence linked cluster sells more than 0.25% of supply.
- A linked cluster contributes more than 35% of buy volume.
- A linked cluster holds more than 20% of supply.
- Any individual wallet holds more than 20% of supply.

Missing creator evidence or attribution confidence below 70% means WATCH, never BUY. Record evidence and confidence; do not infer wallet linkage from timing alone.

### Execution economics

Before entry, obtain fresh, size-specific buy and sell quotes. Require:

- Entry impact <= 2%.
- Exit impact <= 2%.
- Buy tax <= 2%.
- Sell tax <= 2%.
- Total round-trip cost <= 4%.

Include current protocol and creator fees, network/priority fees, price impact, slippage, and simulated latency. Unknown or unavailable costs mean no entry. Never substitute a chart price or reserve-delta proxy for an executable quote.

## Position sizing and portfolio controls

Initial paper portfolio: $2.70. Initial stake: $1.00. Initial maximum concurrent positions: one. The current agreed growth checkpoints are:

| Portfolio equity | Maximum concurrent positions | Stake per trade |
|---:|---:|---:|
| $2.70 initial | 1 | $1.00 |
| $5 | 2 | $1.50 |
| $10 | 3 | $2.00 |

Implement sizing and concurrency as a deterministic portfolio policy, not hard-coded UI values. Apply the portfolio-doubling rule for later growth, increase stake by 50% at each doubling, and cap stake at $100. Never allow committed principal plus fees to exceed available paper equity. Only a fully closed position with confirmed zero token balance releases a slot. Never enter the same mint twice.

## Exit — adaptive, no holding-time cap

There is no maximum holding duration. A position may remain open as long as its market remains valid and the exit policy does not trigger.

Keep the established protective exits:

- Hard stop: -5% net price move from entry, adjusted for executable costs.
- Trailing protection activates at +10%.
- After activation, trailing level is 40% below the highest completed observation.
- Profit-lock floors: +10% reached locks +5%; +50% locks +15%; +100% locks +40%; +200% locks +80%.
- Active protective level is the highest of hard stop, trailing level, and profit-lock floor. It never moves down.

Add dynamic market-exhaustion exits, but do not exit on one noisy observation. Track rolling 2s/5s/10s/30s windows for:

- Buy and sell quote volume and their ratio.
- Unique buyers and sellers, buyer/seller rate changes.
- Net flow and acceleration/deceleration.
- Price response per unit of buy volume.
- Real SOL reserves / pool liquidity and executable sell quote.
- Large-holder, creator and linked-wallet distribution.

A dynamic sell signal must be confirmed by multiple independent bearish observations over consecutive windows. Initial signal thresholds are configuration candidates for paper calibration, not established strategy rules. Persist the exact features and reason for every exit. The hard stop and trailing/profit locks remain immediate protective exits; dynamic exhaustion signals use confirmation to avoid reacting to a single thin window.

## Migration while holding

Migration is a market-state transition, not an automatic sell instruction.

1. Before migration: monitor the Pump.fun bonding curve and its sell quote.
2. Detect migration/graduation from authoritative on-chain state and record slot/time.
3. Mark the position MIGRATION_PENDING; do not fabricate a curve sell or close the position.
4. Discover and verify the migrated pool and its actual route (initially PumpSwap only unless another venue is explicitly enabled).
5. Require fresh pool state, liquidity, token balance, and size-specific executable sell quote.
6. Once verified, transition to MIGRATED_MARKET and continue applying the same protective and dynamic exit policy against the migrated market.
7. Do not sell solely because the token migrated.
8. If no valid market/route or sell quote is available, mark EXIT_BLOCKED / UNEXECUTABLE, alert, keep the position open in the ledger, and retry with bounded backoff. Never report a simulated fill without a verified quote.

A migration event must not release a portfolio slot. The slot is released only after a valid simulated exit and zero token balance are confirmed.

## System safety

- One active worker leader lease; prevent duplicate workers from opening duplicate positions.
- Idempotency keys for every candidate entry and position transition.
- Append-only event and quote ledger; persist raw source payloads with secrets redacted.
- Freeze new entries on provider lag, stale data, database errors, or failed quote verification; continue managing existing positions where reliable market data is available.
- Global paper-trading kill switch stops new entries but does not discard open positions or disable their exit monitoring.
- Dashboard shows open migrated positions, exit blockers, data freshness, provider lag, and every exit reason.
- No live trading capability is included in this deployment.
