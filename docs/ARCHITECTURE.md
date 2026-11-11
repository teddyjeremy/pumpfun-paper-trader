# Architecture and result pipeline

## Pipeline

1. **Discovery** — Helius Solana stream detects Pump.fun program transactions; decode using the current official Pump SDK / IDL.
2. **Enrichment** — fetch mint, curve, creator and metadata evidence. Store source slot and observation time.
3. **Risk gates** — fail closed on dangerous authorities/extensions, missing critical data, poor holder distribution, creator/insider risk, insufficient real reserves or inability to obtain a fresh sell quote.
4. **Economics** — obtain Pump bonding-curve buy and sell quotes for the exact paper notional. Include current protocol/creator fee schedule, network and priority fees, impact and slippage. Unknown = reject.
5. **Activity and momentum** — calculate 2/5/10/30/60 second windows. Track unique buyers/sellers, quote-volume, tx rates, price acceleration and reserve changes.
6. **Decision** — apply the strict original entry rules only. Persist accepted and rejected decisions with reasons.
7. **Paper execution** — refresh quote after simulated latency; never invent a fill.
8. **Position monitoring** — monitor curve positions; on migration verify the migrated pool and continue monitoring there. Migration alone never sells.
9. **Dynamic exit** — protective stops plus confirmed market-exhaustion signals. No maximum holding duration.
10. **Analysis** — report net PnL, cost breakdown, latency, rejection reasons, quote failures, drawdown and execution quality.

## Results that must be visible

- Candidate funnel: discovered → enriched → risk-passed → quoted → watchlisted → entered → exited.
- Rejection counts grouped by reason and time window.
- Quote coverage, freshness, p50/p95 latency and failure rates.
- Open positions and market state (curve, migration pending, migrated, exit blocked).
- Gross move versus fees/impact/slippage versus net PnL.
- Migration events, migrated pool verification, and exits blocked by missing routes/quotes.
- Provider stream health, last slot, reconnect count and ingestion lag.
- Strategy version and configuration hash for every decision.

## Failure diagnosis

A provider outage is not a strategy failure. A rejected candidate is not a quote failure. An unavailable sell quote is not a successful exit. A position cannot free a slot until the simulated token balance is zero. A migration event is not a sell. Diagnostics must preserve these distinctions in event types and dashboard filters.

## Data integrity

Use raw integer lamports and token base units for amounts, and a decimal library for human-readable arithmetic. Persist original quote payloads (redacting secrets), timestamps, context slot, and SDK version. Keep an append-only event log; derive dashboards from stored events rather than in-memory counters.
