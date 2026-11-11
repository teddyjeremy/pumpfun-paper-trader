# Operations, results and failure investigation

## Endpoints

- `GET /health`: process liveness only.
- `GET /ready`: readiness; returns HTTP 503 while required live adapters or the ledger are missing.
- `GET /api/diagnostics`: counters, categorized recent failures, readiness blockers, uptime and memory.
- `GET /api/results/summary`: initial portfolio policy, activity counts and diagnosis.
- `GET /api/tracking`: candidate funnel, provider, graduation, quote and position telemetry.
- `GET /`: operator dashboard.

## How to interpret results

| Observation | Meaning | Next investigation |
|---|---|---|
| Zero discoveries | Stream disconnected, subscription wrong, or no launches observed | Provider connection, subscription, slot lag |
| Discoveries but zero quotes | Bonding-curve or PumpSwap quote path failing | Program/account decoding and SDK quote adapter |
| Many quote failures | Stale state, RPC lag, unsupported account layout | Quote error category and source slot |
| Many cost rejections | Fees/impact consume expected edge | Keep hard cost gate; inspect quote economics |
| Many risk rejections | High-risk launches or incomplete evidence | Inspect the individual rejection reason |
| No entries, healthy quotes | Original entry gates not met | Inspect feature windows; do not lower safety gates blindly |
| Position pending after migration | Canonical PumpSwap pool or fresh sell quote not verified | Pool discovery, migration signature and quote freshness |
| Position not closing | No sell signal, sell quote unavailable, or exit loop stalled | Position state, market windows and venue-specific sellability |
| PnL differs across runs | Different quotes, latency assumptions or strategy/config version | Compare quote snapshots and simulator profile |

## Exit and migration rules

- There is no maximum holding-time exit. Position age is telemetry only.
- Graduation is a venue transition, not a sell signal.
- Existing positions switch from the bonding curve to the verified canonical PumpSwap pool and continue under the same exit manager.
- If migration is detected but the pool is not yet verified, preserve the position and mark the handoff pending. If an exit signal fires during handoff, retain it and retry quote acquisition.
- The hard stop (-5%), trailing activation (+10%), trailing distance (40% below the highest completed observation) and profit-lock floors (+5%, +15%, +40%, +80% after the corresponding milestones) remain active.
- A fall in buying alone does not trigger a sale. The initial dynamic paper candidate requires a 50% buy-volume decline versus the preceding three completed 5-second windows, plus three consecutive recent windows with sell volume at least 1.5x buy volume, more sellers than buyers, and non-positive price change. These are configurable test parameters, not proven optimal thresholds.
- A sell signal is not a fill. Obtain a fresh size-specific quote from the active venue, apply simulated latency, refresh the quote, and persist the fill only if it remains valid.
- A position slot is released only after the simulated sell is recorded and zero token balance is confirmed.

## Required event fields

Every candidate decision should store mint, observed slot/time, source, curve state, metadata completeness, risk evidence, momentum features, quote input/output, quote age, protocol/creator/network fees, impact, slippage, decision, rejection reasons, strategy version, config hash and correlation ID.

Every migration event should store the curve-complete observation, migration signature, canonical PumpSwap pool address, pool verification evidence, source slot and the timestamp at which the active quote venue changed.

Every simulated fill should store raw SOL/token amounts, decimals, quote timestamp, simulated latency, refreshed quote, venue, cost components, exit reason and realized net PnL. Never record a fill if the venue/quote cannot be verified.

## Alerts

- Provider disconnected for more than 15 seconds.
- Stream lag greater than 5 slots.
- No successful quote for 30 seconds while discoveries continue.
- Any stale quote used for a fill (target: zero).
- Any new entry on a migrated token (target: zero; trigger kill switch).
- Migration detected but pool not verified for more than 15 seconds.
- Exit signal without a fresh venue-specific sell quote.
- Any duplicate mint position or slot released with nonzero token balance.
- Persistence write failure or event-loop delay greater than 1 second.
- Any worker lease conflict or second active worker.

## Safe operating sequence

1. Start with no trading decisions enabled; validate discovery and event decoding.
2. Verify bonding-curve state and migration detection against official Pump program interfaces.
3. Verify canonical PumpSwap pool discovery and exact sell quotes after migration.
4. Run quote-only mode; verify fees, price impact and slippage.
5. Replay recorded events and compare deterministic results.
6. Enable paper execution only after readiness is true and all hard gates pass.
7. Test restart recovery with open positions on both venues.
8. Review rejection and exit-signal categories before changing thresholds.

A short integration run validates operations, not profitability.

## Current telemetry limitation

The in-process tracker is volatile and resets on restart. It is a telemetry foundation, not a durable historical ledger. PostgreSQL event/quote/position persistence and real adapter instrumentation are required before dashboard counters represent live market activity. Never interpret empty counters as evidence of zero failures or profitable trading.
