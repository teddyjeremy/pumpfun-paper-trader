# Architecture and result pipeline

## Pipeline

1. **Discovery** — Helius Solana stream detects Pump program transactions; decode with the current official Pump SDK / IDL.
2. **Enrichment** — fetch mint, curve, creator and metadata evidence. Store source slot and observation time.
3. **Risk gates** — apply the original strategy's creator, wallet, cluster, holder, token-authority, liquidity and market-integrity checks. Missing critical evidence fails closed.
4. **Entry economics** — obtain a fresh Pump bonding-curve buy and sell quote for the exact configured paper notional. Include protocol/creator fees, network/priority fees, impact and slippage. Unknown = reject.
5. **Activity and momentum** — calculate the original entry windows and track unique buyers/sellers, verified quote volume, tx rates, price acceleration and reserve changes.
6. **Decision** — apply the original entry rules only. No concentrated-flow or relaxed entry path. Persist accepted and rejected decisions with exact reasons and strategy/config version.
7. **Paper execution** — refresh the buy quote after simulated latency; never invent a fill. Persist the position and entry cost before marking it open.
8. **Position management** — continue tracking the position indefinitely until a protective stop or dynamic sell condition fires. No maximum holding-time exit.
9. **Migration handoff** — when the curve completes, stop curve quoting for that position, discover and verify the canonical PumpSwap pool, then switch its market data and quote source. Graduation alone never sells the position. New entries remain bonding-curve-only.
10. **Exit execution** — request a fresh sell quote from the active venue, apply the same cost/freshness checks, simulate latency, refresh the quote and persist the simulated sell. If unavailable, preserve the position and pending exit signal.
11. **Analysis** — report net PnL, cost breakdown, time-in-trade (as a metric only), rejection reasons, quote failures, drawdown, migration outcome and execution quality.

## Results that must be visible

- Candidate funnel: discovered → enriched → risk-passed → quoted → watchlisted → entered → exited.
- Rejection counts grouped by reason and time window.
- Quote coverage, freshness, p50/p95 latency and failure rates.
- Open positions and slot state (including buy-in-flight, sell-in-flight and migration handoff).
- Gross move versus fees/impact/slippage versus net PnL.
- Graduation events, time to pool verification and exits that became unexecutable.
- Provider stream health, last slot, reconnect count and ingestion lag.
- Strategy version and configuration hash for every decision.
- Position age as telemetry only; it must never cause an automatic time-based exit.

## Failure diagnosis rules

A provider outage is not a strategy failure. A candidate rejected by a risk gate is not a quote failure. An unavailable sell quote is not a successful exit. A migrated position remains open until a valid sell is simulated and the ledger confirms zero token balance. A position cannot free a slot until that confirmation. Diagnostics must preserve these distinctions.

## Data integrity

Use raw integer lamports and token base units for amounts, and a decimal library for human-readable arithmetic. Persist original quote payloads (redacting secrets), timestamps, context slot, venue and SDK version. Keep an append-only event log; derive dashboards from stored events rather than in-memory counters.
