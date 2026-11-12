# Operations, results and failure investigation

## Endpoints

- `GET /health`: process liveness only.
- `GET /ready`: readiness; returns HTTP 503 while required live adapters or the ledger are missing.
- `GET /api/diagnostics`: counters, categorized recent failures, readiness blockers, uptime and memory.
- `GET /api/results/summary`: portfolio configuration, activity counts and diagnosis.
- `GET /api/tracking`: candidate funnel, rejection reasons, quote outcomes, latency, provider health, graduation and position telemetry.
- `GET /api/helius/backfills?sessionId=...`: per-mint address-history and transaction-decoding coverage.
- `GET /api/strategy/replay?sessionId=...`: chronological replay of archived, verified historical SOL-quoted trade events, with optional outcome labeling; explicit favorable/adverse thresholds and a round-trip cost are required to assign profitability labels.
- `GET /`: operator dashboard.

## How to interpret the results

| Observation | What it usually means | Next investigation |
|---|---|---|
| Zero discoveries | Stream disconnected, subscription wrong, or no launches observed | Provider connection, subscription, slot lag |
| Discoveries but zero quotes | Bonding-curve fetch/decode/quote path failing | Program/account decoding and SDK quote adapter |
| Many quote failures | Stale curve state, RPC lag, unsupported account layout | Quote error category and source slot |
| Many cost rejections | Fees/impact consume expected edge | Keep hard cost gate; evaluate market conditions |
| Many risk rejections | High-risk launches or incomplete risk evidence | Inspect individual rule and missing evidence |
| No entries, healthy quotes | Strict momentum/quality gates not met or expected net return insufficient | Review feature windows and decision reasons; do not relax safety gates blindly |
| Open positions not closing | Sell quote unavailable, migration transition incomplete, or exit loop stalled | Position market state, migrated-pool verification and sellability events |
| PnL differs across runs | Different quotes, latency assumptions or config version | Compare quote snapshots, strategy version and simulator profile |

## Required event fields

Every candidate decision should store: mint, observed slot/time, source, curve address/state, metadata completeness, risk score and evidence, momentum feature windows, quote input/output, quote age, protocol/creator/network fee breakdown, price impact, slippage assumption, decision, rejection reasons, strategy version and correlation ID.

Every simulated fill should store raw SOL/token amounts, decimals, quote timestamp, simulated latency, refreshed quote, cost components, exit reason and realized net PnL. Do not record a fill if the curve or migrated-pool quote cannot be verified.

## Alert thresholds

- Provider disconnected for > 15 seconds.
- Stream lag > 5 slots.
- No successful quote for 30 seconds while discoveries continue.
- Any stale quote used for a fill (must be zero).
- Any unverified migrated market used for a mark or exit (must be zero).
- Any duplicate active position for a mint or duplicate worker leader.
- Any slot released before zero token balance confirmation.
- Persistence write failure or event-loop delay > 1 second.
- An open position remains exit-blocked after migration; alert and keep retrying rather than fabricating a close.

## Safe operating sequence

1. Start with no trading decisions enabled; validate discovery and event decoding.
2. Verify bonding-curve account state against official SDK examples and independently sampled RPC reads.
3. Verify graduation detection and migrated-pool discovery against on-chain account state.
4. Run quote-only mode on both bonding curve and migrated pool; verify fee accounting.
5. Replay historical/recorded events and compare deterministic results.
6. Enable paper execution only after readiness is true and all hard gates pass.
7. Review failure categories and rejected candidates before changing thresholds.

A multi-hour test validates integration and operational behavior, not profitability.

## Historical replay

Historical replay requires the additive PostgreSQL migrations through `0007_helius_decode_coverage`. Apply migrations only through the documented operator migration command after reviewing the SQL and taking a database backup; application startup does not migrate automatically.

The replay endpoint excludes live-monitor-only observations and only labels outcomes when:
- address-history coverage is complete,
- every scanned signature has a verified or confirmed-failed terminal outcome,
- every verified historical transaction is durably archived,
- explicit favorable/adverse excursion thresholds are supplied.

The replay uses SOL-quoted reserve observations and current SOL/USD normalization. It is not an executable SDK fill simulation, does not model the complete dynamic exit lifecycle, and must not be interpreted as realized PnL. Calibration recommendations remain advisory and require a separate chronological holdout review.

## Instrumentation contract

The current tracker is process-memory only and resets on restart. It is a telemetry foundation, not a durable historical analytics system. PostgreSQL event persistence and real adapter instrumentation are required before dashboard counters represent live market activity. Never interpret an empty chart/counter as evidence of zero failures or profitable trading.

## Migration-aware operations

Migration is not a sell signal. Positions transition from curve monitoring to a verified migrated-market monitor. If a valid migrated pool or fresh sell quote is temporarily unavailable, keep the position open in an exit-blocked state, show the last verified mark as stale, alert, and retry with bounded backoff. Do not release the position slot until a valid simulated exit and zero token balance are confirmed.
