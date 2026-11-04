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
| Discoveries but zero quotes | Bonding-curve fetch/decode/quote path failing | Program/account decoding and SDK quote adapter |
| Many quote failures | Stale curve state, RPC lag, unsupported account layout | Quote error category and source slot |
| Many cost rejections | Fees/impact consume expected edge | Keep hard cost gate; evaluate market conditions |
| Many risk rejections | High-risk launches or incomplete risk evidence | Inspect individual rule and missing evidence |
| No entries, healthy quotes | Momentum/quality gates not met or expected net return insufficient | Review feature windows and decision reasons; don't lower safety gates blindly |
| Open positions not closing | Sell quote unavailable, curve graduated, or exit loop stalled | Position state, graduation and sellability events |
| PnL differs across runs | Different quotes, latency assumptions or config version | Compare quote snapshots, strategy version and simulator profile |

## Required event fields

Every candidate decision should store: mint, observed slot/time, source, curve address/state, metadata completeness, risk score and evidence, momentum score and feature window values, quote input/output, quote age, protocol/creator/network fee breakdown, price impact, slippage assumption, decision, rejection reasons, strategy version and correlation ID.

Every simulated fill should store raw SOL/token amounts, decimals, quote timestamp, simulated latency, refreshed quote, cost components, exit reason and realized net PnL. Do not record a fill if the curve/quote cannot be verified.

## Alert thresholds (initial, tune after observing baseline)

- Provider disconnected for > 15 seconds.
- Stream lag > 5 slots.
- No successful quote for 30 seconds while discoveries continue.
- Any stale quote used for a fill (should be zero).
- Any attempt to route to PumpSwap (should be zero and trigger kill switch).
- Any paper position older than configured maximum holding time.
- Any negative balance, duplicate mint position, or slot released with nonzero token balance (invariant violation).
- Persistence write failure or event-loop delay > 1 second.

## Safe operating sequence

1. Start with no trading decisions enabled; validate discovery and event decoding.
2. Verify bonding curve account state against official SDK examples and independently sampled RPC reads.
3. Run quote-only mode; verify buy and sell quote arithmetic and full fee accounting.
4. Replay historical/recorded events and compare deterministic results.
5. Enable paper execution only after readiness is true and all hard gates pass.
6. Review failure categories and rejected candidates before changing thresholds.

A three-hour test validates integration and operational behavior, not profitability.
