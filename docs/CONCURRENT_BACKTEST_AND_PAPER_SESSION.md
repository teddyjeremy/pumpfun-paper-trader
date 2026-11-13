# Concurrent historical backtesting and forward paper trading

## Operating model

Historical replay and forward live-market-data paper trading are separate workloads. They can run at the same time; neither needs to wait for the other to finish. They are not interchangeable and must not share mutable state.

| Concern | Historical replay | Forward paper session |
|---|---|---|
| Input | Fixed Nairobi-local date and historical Pump launch events | New events arriving from the live market stream |
| State | GitHub Actions artifacts, dated discovery/screen/replay checkpoints | Worker Durable Object state, fenced Neon lease, paper portfolio |
| Output | Per-coin datasets, candidate ranking, historical dashboard summary | Simulated entries/exits, portfolio snapshots, append-only event history |
| Budget | Shared historical ceiling of 30,000 Helius credits, including the 16,778 legacy sunk credits | Existing approved provider budget and wallet-history cap: at most 16 wallets and 2 pages per wallet per refresh |
| Safety | Research-only; never signs/submits and never enables the Worker | Simulator only; no private key, signing, or on-chain submission |

## Shared prerequisites

1. Apply Neon migrations in order through `0010_historical_backtest_dashboard`.
2. Confirm the GitHub Actions `DATABASE_URL` secret exists without exposing its value.
3. Verify the production dashboard and Worker use the intended Neon database.
4. Monitor the Helius account's aggregate credit usage. The historical budget and forward-session provider usage are separate ledgers but may draw from the same provider account.
5. Do not raise the approved wallet/page caps or refresh frequency without renewed operator approval.

## Start historical replay

After migrations and the database-secret preflight are verified, manually dispatch **Historical paper replay (checkpointed)** with:

- Date: `2026-11-12`
- Previous run ID: `43488935615` (latest incomplete checkpoint artifact; do not resume from the older legacy run `43442196641`).

Resume subsequent runs from the most recent artifact run ID containing the dated checkpoint. Keep each run's artifacts and checkpoints attached to that date. Do not reuse a checkpoint for another date.

## Start forward paper trading independently

The forward session may start while historical replay is still running, but only after its own production acceptance gate passes:

- authenticated Worker-to-dashboard event ingestion acknowledged and persisted;
- fenced Neon lease acquired and heartbeat verified;
- one complete simulated entry and one complete simulated exit recorded;
- idempotency, portfolio accounting, and fee/rent reserves reconciled;
- Worker restart restores the same positions and pending transitions;
- dashboard reload matches the durable Neon ledger;
- `tradingReady=true` is produced by runtime prerequisites, not manually forced.

If any gate fails, leave `tradingReady=false` and do not declare the forward session active.

## Isolation and stop conditions

- Historical replay may write only historical research tables and its own artifact/checkpoint namespace.
- The forward session may write only its paper-session ledger and event namespace.
- Never let historical candidate ranking create, close, or mark a forward paper position.
- Never let a historical run acquire, renew, or release the forward Worker lease.
- Stop either workload if its own checkpoint is corrupt, its budget cannot be reconciled, or its persistence preflight fails.
- A failure in one workload must not silently mark the other complete or clear its incomplete evidence.
- No workload in this project is authorized to sign or submit a real Solana transaction.

## Reporting

Report each workload independently: run/session ID, date or time window, status, last durable checkpoint, credits consumed, incomplete items, and next resume point. A completed historical replay is not proof that forward paper trading is ready; a successful forward smoke test is not historical strategy validation.
