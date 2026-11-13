# Paper-trading readiness

Last reviewed: 2026-11-13

## Current decision

**Paper trading is not enabled.** Keep `tradingReady=false`. The system must remain non-signing and non-submitting: no wallet private key, transaction signing, or on-chain submission is part of this paper-trading readiness work.

This document is the operational checklist for reaching the first verified simulated trade. A feature being implemented is not the same as its production path being verified.

## Readiness gates

### 1. CI and release integrity

- [x] Latest code-changing commit verified by CI is `d74f0dd46ddbecda50f9b1c8846930a90c94e7ae`: dependency installation, TypeScript checks, 58 test files / 435 tests, and Cloudflare Worker bundle.
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
- [x] Historical risk evidence is replayed as a timestamped timeline; later evidence cannot clear an earlier candidate and incomplete refreshes revoke prior clearance.
- [ ] Connect complete buyer-set provenance from fully decoded launch-window events to wallet-history collection.
- [ ] Prove complete transaction history for every wallet used in the candidate's risk decision; sampled signatures are not sufficient.
- [ ] Connect complete holder census and wallet evidence to the same candidate-time strategy evaluation.
- [ ] Verify common-funder, coordinated-wallet, and concentration rules against realistic fixtures and persisted historical data.
- [ ] Keep risk status UNKNOWN/WATCH whenever any required evidence is missing, stale, partial, or contradictory.

### 4. Strategy calibration and historical replay

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
- [x] Portfolio entry guard checks available cash against stake, both buy/sell fee estimates, and refundable rent before opening; regression-tested for an insufficient sell-fee budget.
- [ ] Verify simulated payer balance, portfolio reserve, and transaction fee budget before an entry.
- [ ] Prove BUY and exact-size SELL quote legs are fresh, same-mint/same-venue, unexpired, and have matching exact-message fee evidence.
- [ ] Explicitly reject unsupported curve versions, cashback/unsupported pool variants, and incomplete account snapshots.

A fee quote or unsigned instruction plan does not prove that a transaction can be executed. The virtual payer balance and full account state must be verified before the simulated entry is allowed.

### 6. Worker paper lifecycle and exits

- [x] Worker route requests exact round-trip quote evidence and records strategy audit evidence.
- [x] Gated simulated entry transition is connected to the strict strategy audit.
- [x] Entry transition additionally requires `paperEntryAuthorized=true` from the unsigned plan; quote validity alone cannot authorize a position.
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
- Worker does not yet supply empirically calibrated strategy volume thresholds.
- Complete contiguous rolling event-stream coverage is not yet available; PumpSwap event decoding and multi-window exhaustion evidence remain outstanding.
- The portfolio now checks the full round-trip cash budget, but verified virtual-payer balance evidence and the end-to-end account-state/rent-to-portfolio path remain unproven; unsigned plans still return `paperEntryAuthorized=false`, so every entry remains blocked.
- Production Neon lifecycle, idempotent persistence, and Worker restart recovery remain unverified.
- Vercel ingestion authentication and dashboard display of persisted simulated trades remain unverified.
- The latest CI run must be green on the final PR head before merge.

## Safety invariant

The paper trader is a simulator. It must not hold or derive a wallet private key, sign a Solana transaction, or submit a transaction to the network. `paperEntryAuthorized` and `tradingReady` must remain false until the corresponding documented evidence and integration tests pass; paper readiness must never imply live-trading authorization.
