# Operations, results and failure investigation

## Endpoints

- `GET /health`: process liveness only.
- `GET /ready`: readiness; returns HTTP 503 while required live adapters or the ledger are missing.
- `GET /api/diagnostics`: counters, categorized recent failures, readiness blockers, uptime and memory.
- `GET /api/results/summary`: portfolio configuration, activity counts and diagnosis.
- `GET /`: live-refreshing operator dashboard.

## How to interpret the results

| Observation | What it usually means | Next investigation |
|---|---|---|
| Zero discoveries | Stream disconnected, subscription wrong, or no launches observed | Provider connection, subscription, slot lag |
| Discoveries but zero quotes | Bonding-curve or PumpSwap quote path failing | Program/account decoding and SDK quote adapter |
| Many quote failures | Stale state, RPC lag, unsupported account layout | Quote error category and source slot |
| Many cost rejections | Fees/impact consume expected edge | Keep hard cost gate; evaluate market conditions |
| Many risk rejections | High-risk launches or incomplete risk evidence | Inspect individual rule and missing evidence |
| No entries, healthy quotes | Original momentum/quality gates not met or expected net return insufficient | Review feature windows and decision reasons; don't lower safety gates blindly |
| Position pending after migration | Canonical PumpSwap pool or fresh sell quote not yet verified | Pool discovery, migration signature, quote freshness |
| Position not closing | No sell signal, sell quote unavailable, or exit loop stalled | Position state, market windows and venue-specific sellability |
| PnL differs across runs | Different quotes, latency assumptions or config version | Compare quote snapshots, strategy version and simulator profile |

## Required event fields

Every candidate decision should store: mint, observed slot/time, source, curve address/state, metadata completeness, risk score and evidence, momentum score and feature window values, quote input/output, quote age, protocol/creator/network fee breakdown, price impact, slippage assumption, decision, rejection reasons, strategy version and correlation ID.

Every simulated fill should store raw SOL/token amounts, decimals, quote timestamp, simulated latency, refreshed quote, cost components, venue, exit reason and realized net PnL. Do not record a fill if the venue/quote cannot be verified.

Every migration event should store the curve-complete observation, migration signature, canonical PumpSwap pool address, pool verification evidence, source slot and the timestamp at which the active quote venue changed.

## Exit policy

- No maximum holding-time exit exists.
- The original hard stop, trailing stop and profit-lock ladder remain active after migration.
- Migration alone is not an exit condition. Switch the position to PumpSwap only after the canonical pool is verified.
- The initial dynamic sell signal is deliberately conjunctive: buy volume falls by at least 50% versus the preceding three completed 5-second windows, and each of the latest three completed 5-second windows has sell volume at least 1.5x buy volume, more sellers than buyers, and non-positive price change.
- A drop in buys without sustained sell pressure and price weakness is a **hold**, not a sell.
- These dynamic-sell thresholds are initial paper-test parameters and must be evaluated from observed data before being treated as final.
- If a sell signal occurs before the migrated pool is verified, retain the pending signal and retry quote acquisition. Do not invent a fill or free the position slot.

## Alert thresholds (initial, tune after observing baseline)

- Provider disconnected for > 15 seconds.
- Stream lag > 5 slots.
- No successful quote for 30 seconds while discoveries continue.
- Any stale quote used for a fill (should be zero).
- Any new entry on a migrated token (should be zero; trigger kill switch).
- Any position with migration detected but no pool verification for > 15 seconds.
- Any exit signal without a fresh venue-specific sell quote.
- Any negative balance, duplicate mint position, or slot released with nonzero token balance (invariant violation).
- Persistence write failure or event-loop delay > 1 second.

## Safe operating sequence

1. Start with no trading decisions enabled; validate discovery and event decoding.
2. Verify bonding curve state and migration detection against official Pump program interfaces.
3. Verify canonical PumpSwap pool discovery and exact sell quote after migration.
4. Run quote-only mode; verify fee accounting, price impact and slippage.
5. Replay historical/recorded events and compare deterministic results.
6. Enable paper execution only after readiness is true and all hard gates pass.
7. Test restart recovery with open positions on both venues.
8. Review failure categories and rejected candidates before changing thresholds.

A three-hour test validates integration and operational behavior, not profitability.

## Live tracking API (current foundation)

- `GET /api/tracking`: candidate funnel, rejection reasons, quote outcomes and cost samples, p50/p95 latency by subsystem, provider reconnects/slot lag, graduation states, position telemetry, invariant violations and recent events.
- The dashboard polls this endpoint every five seconds and includes the tracking output.
- `src/diagnostics/tracker.ts` exports typed functions for discovery stages, decisions, risk, momentum, quote outcomes, latency, provider state, graduation and position state.

The current tracker is process-memory only and resets on restart. It is a telemetry foundation, not a durable historical analytics system. PostgreSQL event persistence and real adapter instrumentation are required before these values represent live market activity. Never interpret an empty chart/counter as evidence of zero failures or profitable trading.
