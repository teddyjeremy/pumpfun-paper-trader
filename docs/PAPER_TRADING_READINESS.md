# Paper-trading readiness

Last reviewed: 2026-11-13

## Current decision

**Paper trading is not enabled.** Keep `tradingReady=false`. The system must remain non-signing and non-submitting: no wallet private key, transaction signing, or on-chain submission is part of this paper-trading readiness work.

This document is the operational checklist for reaching the first verified simulated trade. A feature being implemented is not the same as its production path being verified.

## Readiness gates

### 1. CI and release integrity

- [x] Latest PR head `37b1160dd54c7ce977fbbc4460401b6c46a39031` passed [GitHub CI run 43420524236](https://github.com/teddyjeremy/pumpfun-paper-trader/actions/runs/43420524236): TypeScript no-emit check, 61 test files / 455 tests, TypeScript build, and Cloudflare Worker bundle.
- [x] Production dashboard deployment `dpl_BARieVKofhUX76xk1JpT3LUqjyVT` is READY at [pumpfun-paper-trader-six.vercel.app](https://pumpfun-paper-trader-six.vercel.app), deployed from main commit `ec643a090e17caf229e7959f089a338b98d8809c`.
- [x] Production Worker deployment succeeded in [Cloudflare deployment workflow 43378493964](https://github.com/teddyjeremy/pumpfun-paper-trader/actions/runs/43378493964); deployed version is `1dac036e-76c4-4ff6-90bc-37345d114c3b` from main commit `ec643a090e17caf229e7959f089a338b98d8809c`.
- [ ] Production Worker smoke health and a complete simulated entry/exit lifecycle remain unverified. The deployed main-branch code still reports `tradingReady=false`; PR #77 is not deployed.
- [x] PostgreSQL-backed integration tests pass in the CI test suite.
- [ ] The final PR head is reviewed and the merge is performed only against that exact tested head.
- [ ] Production smoke tests pass after the single planned deployment.

### 2. Historical data completeness

- [x] Backfill coverage helper rejects empty/duplicate source signatures, unrelated queue entries, archived-but-unverified signatures, and signatures that are both queued and terminal.
- [x] Worker passes unfiltered stored evidence to the integrity checker and fails closed on inconsistent state.
- [ ] Confirm the live backfill worker archives every expected signature and records verified/failed terminal outcomes.
- [ ] Demonstrate contiguous, complete launch-window event coverage with persisted provenance.
- [ ] Ensure retry exhaustion, pagination truncation, missing transactions, and decoder errors cannot be interpreted as complete coverage.

### 3. Buyer, wallet-cluster, and holder risk

- [x] Two-pass holder census implementation with pagination, stable supply/slot checks, owner aggregation, and fail-closed incomplete states.
- [x] Wallet evidence distinguishes full SOL-transfer history from full wallet transaction history.
- [ ] Production Cloudflare Worker does not yet have `FULL_WALLET_HISTORY_ENABLED`; PR #77 now sets it to `true` with `FULL_WALLET_HISTORY_MAX_PAGES=2` for the next deployment. Collection is bounded to at most 16 wallets and 2 pages per wallet; a candidate is refreshed at most once per minute, normally every 10 minutes or earlier when its observed wallet set changes. This will consume Helius credits after deployment, so the PR remains unmerged pending review of that bounded usage.
- [x] Historical risk evidence is replayed as a timestamped timeline; later evidence cannot clear an earlier candidate and incomplete refreshes revoke prior clearance.
- [ ] Connect complete buyer-set provenance from fully decoded launch-window events to wallet-history collection.
- [ ] Prove complete transaction history for every wallet used in the candidate's risk decision; sampled signatures are not sufficient.
- [ ] Connect complete holder census and wallet evidence to the same candidate-time strategy evaluation.
- [ ] Verify common-funder, coordinated-wallet, and concentration rules against realistic fixtures and persisted historical data.
- [ ] Keep risk status UNKNOWN/WATCH whenever any required evidence is missing, stale, partial, or contradictory.

### 4. Strategy calibration and historical replay

- The Worker accepts volume thresholds only through `REVIEWED_VOLUME_THRESHOLDS_JSON`, containing a versioned, explicitly approved replay candidate, reviewer, review timestamp, and source session.
- The Worker rejects missing, malformed, unapproved, stale (older than 30 days), under-sampled, or holdout-failing calibration payloads; absent or rejected calibration leaves both mandatory volume rules UNKNOWN.
- The production Worker does not currently have a reviewed threshold payload configured. Do not invent or promote values to make the strategy pass.
- The Worker computes `tradingReady` from runtime prerequisites: active session, both connected streams, full wallet history, reviewed calibration, official SDK modules, configured event ingestion, and a held fenced persistence lease. A true value does not itself prove a completed entry/exit lifecycle; that must be verified separately in the durable journal/dashboard.


- [ ] Build a reproducible historical dataset from verified launches, trades, wallet evidence, and holder snapshots.
- [ ] Define and compute calibrated volume thresholds from that dataset.
- [ ] Calibrate buyer activity, liquidity, price response, wallet freshness, concentration, and entry timing thresholds.
- [ ] Include fees, rent reserve, quote impact, slippage, and failed-entry costs in replay.
- [x] Calibration reports sample size, win rate, net expectancy, profit factor, and chronological compounded max drawdown for training and holdout.
- [ ] Validate the reported metrics against a real, fully evidenced historical dataset and perform sensitivity analysis across thresholds.
- [ ] Validate the full set of 15 mandatory strategy rules using evidence produced by the real collectors.
- [ ] Do not weaken mandatory rules or fabricate evidence to force BUY decisions.

### 5. Unsigned transaction plans and quote evidence

- [x] Public-only deterministic virtual trader identity; no signing capability.
- [x] ATA prerequisite inspection and legacy SPL ATA rent calculation.
- [x] Pump Curve V3 and PumpSwap V2 unsigned instruction-plan builders.
- [x] Exact-message fee evidence is composed over the planned instruction set.
- [ ] Verify Curve V3 and PumpSwap V2 instruction/account layouts against pinned SDK fixtures and realistic chain snapshots.
- [ ] Verify all curve/pool, Global config, fee recipient, buyback recipient, creator vault, mint, token program, ATA, and volume-accumulator accounts required by each supported path.
- [ ] Verify user volume accumulator initialization instruction and rent handling on the final message.
- [ ] Verify all required ATA creation instructions are included exactly once and rent is reserved.
- [ ] Complete extension-aware Token-2022 account sizing or reject missing Token-2022 accounts.
- [x] Portfolio entry guard checks available cash against stake, both buy/sell fee estimates, and refundable rent before opening; regression-tested for insufficient and concurrent exit-fee budgets.
- [x] Worker derives entry authorization only after both exact unsigned plans have no unresolved account blockers and a pure portfolio preview passes the stake, buy/sell fee, and refundable-rent budget.
- [ ] Verify simulated payer balance, portfolio reserve, and transaction fee budget before an entry.
- [ ] Prove BUY and exact-size SELL quote legs are fresh, same-mint/same-venue, unexpired, and have matching exact-message fee evidence.
- [ ] Explicitly reject unsupported curve versions, cashback/unsupported pool variants, and incomplete account snapshots.

A fee quote or unsigned instruction plan does not prove that a transaction can be executed. The virtual payer balance and full account state must be verified before the simulated entry is allowed.

### Portfolio sizing and concurrency invariants

- Start with a $1 stake and one concurrent position.
- At $5 equity, add one concurrent slot and increase the stake to $1.50; at each subsequent equity doubling, add one slot and compound the current stake by 50% ($2.25 at $10, $3.375 at $20, etc.), capped at $100.
- Count only closed positions as released slots. An open or exit-blocked position continues to occupy its slot.
- A mint may be entered only once per paper session, including after its position has closed.

### 6. Worker paper lifecycle and exits

- [x] Worker automatically requests a fresh exact-size SDK round-trip quote only after all thirteen non-quote strategy rules pass, a free portfolio slot exists, and the verified market venue matches the candidate.
- [x] Automatic quote attempts are idempotently scoped to a reclaim signal; a successful quote triggers a fresh strategy audit, while failures remain blocked.
- [x] Worker route requests exact round-trip quote evidence and records strategy audit evidence.
- [x] Gated simulated entry transition is connected to the strict strategy audit.
- [x] Quote validity alone cannot authorize a position; the Worker independently validates both unsigned plan evidence objects and previews the real portfolio transition before granting entry authorization.
- [x] Simulated entries additionally require the active PostgreSQL ingestion configuration and fenced Worker lease, preventing ephemeral-only entries.
- [x] Scheduled protective-exit cycle requests fresh full-position sell quotes.
- [x] Portfolio marks are deferred until every open position has a fresh quote.
- [ ] Prove one complete simulated entry and exit with the real Worker state machine.
- [ ] Prove concurrent requests, retries, and scheduled invocations cannot duplicate or corrupt transitions.
- [ ] Verify portfolio accounting, cost basis, reserved capital, fees, realized/unrealized P&L, and rent reserve reconciliation.
- [ ] Verify the Worker lease prevents multiple active executors.
- [ ] Verify restart recovery reconstructs every open position and pending transition from durable storage.
- [ ] Test protective stops, hard stops, trailing stops, profit locks, and quote-unavailable behavior.

### 7. Dynamic exhaustion exits

- [x] Dynamic exhaustion evidence requires `VERIFIED_COMPLETE_EVENT_STREAM`, not merely observed events.
- [x] Current observed-only Pump curve data is not accepted as complete event-stream proof.
- [ ] Implement and verify contiguous rolling event-stream coverage with gap detection and durable provenance.
- [ ] Implement a dedicated PumpSwap trade-event decoder and independent evidence path.
- [ ] Produce complete 2-, 5-, 10-, and 30-second windows for supported venues.
- [ ] Add timestamped holder-distribution time series.
- [ ] Calibrate dynamic exit thresholds from historical replay rather than treating initial paper values as optimized.

Until these items pass, dynamic exhaustion remains disabled. Protective exits still require fresh full-position quotes and must fail safely when market evidence is unavailable.

### 8. Neon persistence and recovery

- [x] Database migrations 0001–0007 have been applied in the configured environment (deployment state still requires verification).
- [ ] Verify production connection and migration version.
- Production Vercel environment contains `DATABASE_URL` and `PAPER_EVENT_INGEST_TOKEN`; Cloudflare has `PAPER_EVENT_INGEST_URL` pointed at the dashboard alias and a `PAPER_EVENT_INGEST_TOKEN` secret binding. The secret values are write-only, so matching and successful event ingestion still need an end-to-end acknowledgement.
- [ ] Persist paper entries, exits, trade state, portfolio snapshots, and append-only events.
- [ ] Enforce idempotency keys and unique constraints for entry/exit transitions.
- [ ] Verify lease acquisition, renewal, expiry, and recovery.
- [ ] Run entry -> exit -> Worker restart -> recovery tests against PostgreSQL.
- [ ] Prove open positions, closed positions, and event history remain consistent after restart.

### 9. Vercel ingestion and dashboard

- [ ] Verify `PAPER_EVENT_INGEST_TOKEN` satisfies the API's minimum length and matches the Worker configuration without exposing it in logs or chat.
- [ ] Verify authenticated Worker-to-Vercel event ingestion returns success and persists the event.
- [ ] Resolve any 503 response before considering the ingestion path ready.
- [x] Add a dashboard read path for persisted Neon paper-session positions and simulated fills.
- [ ] Verify dashboard open positions, closed trades, candidates, event history, portfolio, and health against a real persisted entry/exit.
- [ ] Verify dashboard data reflects a real persisted simulated entry and exit in the deployed environment.
- [ ] Verify dashboard state after Worker restart and page reload.

Do not rotate the shared ingestion token without coordinated authorization to update both environments. Never put the token value in repository documentation, commits, logs, or chat.

### 10. Single-batch merge and deployment

- [ ] Complete and test all changes on the existing `batch/unsigned-execution-readiness` branch and PR #77.
- [ ] Keep changes batched; do not repeatedly deploy production during implementation.
- [x] `vercel.json` keeps `main` deployments enabled and disables Vercel preview deployments for `batch/unsigned-execution-readiness`; no new preview deployment was created after the configuration commit. The production alias remains on main.
- [ ] Review the final diff and all CI jobs on the exact PR head.
- [ ] Merge only when all required checks are green and the integration tests pass.
- [ ] Perform the planned production deployment once.
- [ ] Run production smoke tests with paper mode only and verify persistence/dashboard integration.
- [ ] Keep live signing and submission disabled.

## First-paper-trade acceptance test

Paper trading may be declared started only after a reproducible test demonstrates all of the following:

1. A real candidate is collected with complete, timestamped event and risk evidence.
2. All 15 mandatory strategy rules pass; no UNKNOWN or missing mandatory evidence is treated as PASS.
3. A fresh exact-size buy quote and exact-size sell quote are available, with exact-message fee evidence.
4. All required account, ATA, rent, simulated-payer, and portfolio-reserve checks pass.
5. The Worker records exactly one simulated entry without signing or submitting a transaction.
6. The scheduled exit path obtains fresh sell evidence and records exactly one simulated exit according to the configured risk rules.
7. Entry, exit, portfolio, and append-only event records are durable in Neon.
8. A Worker restart restores the correct portfolio and positions without loss or duplication.
9. The dashboard shows the same open/closed trade and event data after reload.
10. Production smoke tests confirm that real signing and on-chain submission remain unavailable.

If any item fails, keep `tradingReady=false` and report the exact blocker. Do not force a trade by bypassing a gate.

## Current known blockers

- Historical buyer-set provenance and complete wallet transaction-history clearance are not yet proven end to end.
- Production full wallet transaction-history collection is still disabled until PR #77 is reviewed and deployed; the branch config enables the bounded collector (16 wallets, 2 pages each) and its Helius credit usage needs approval.
- No empirically validated and operator-reviewed volume calibration is configured in production; the Worker now accepts only an explicit approved payload and remains fail-closed without it.
- Complete contiguous rolling event-stream coverage is not yet available; PumpSwap event decoding and multi-window exhaustion evidence remain outstanding.
- The Worker now treats the paper portfolio as the simulated payer budget and previews stake, both exact fee legs, and refundable ATA/accumulator rent before an entry. Actual Worker-to-Vercel/Neon ingestion and production account-state/rent reconciliation remain unverified; quote-only unsigned plans continue to return `paperEntryAuthorized=false`.
- Production Neon lifecycle, idempotent persistence, and Worker restart recovery remain unverified.
- Vercel ingestion authentication and dashboard display of persisted simulated trades remain unverified.
- The latest CI run must be green on the final PR head before merge.

## Safety invariant

The paper trader is a simulator. It must not hold or derive a wallet private key, sign a Solana transaction, or submit a transaction to the network. The quote-only unsigned plan remains unauthorized; Worker-level paper entry authorization is derived only after complete plan checks and a successful portfolio budget preview. `tradingReady` remains false until the complete live Worker/Neon/dashboard acceptance test passes; paper readiness must never imply live-trading authorization.
