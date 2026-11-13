# November 12 historical strategy replay

This is a historical, paper-only data collection and replay. It does not sign transactions, submit transactions, or enable the live Worker.

## Credit budget and recovery

The shared end-to-end ceiling is **30,000 Helius credits**, including the 16,778 credits already spent by the failed legacy standard-RPC discovery attempt. That old partial crawl is recorded as sunk spend only; its signatures are not reused.

The replacement discovery uses Helius Parsed Events Scan with exact Nairobi-local time bounds and only Pump `create`/`create_v2` instructions. It divides the day into 100 equal-width time buckets, scans at most five pages of 10,000 scanned transactions per bucket, and verifies at most one selected Create transaction per bucket. New discovery is capped at 5,000 credits. The one-page-per-curve activity screen is capped at 500 credits. Deep replay uses the remaining balance under the shared 30,000-credit ceiling. Every scan response's reported charge and every standard RPC request are counted.

Parsed Events Scan is a paid-plan/beta capability. If the API key cannot access it, the workflow stops and saves its checkpoint; it does not fall back to the expensive legacy crawl. A bucket that exhausts its page limit or encounters a verification/scan error is `INCOMPLETE`, never silently classified as empty. A completed discovery requires all 100 buckets to be explicitly `FOUND` or `EMPTY`.

The previous legacy run is `43442196641`. To resume with its sunk-credit accounting, manually dispatch **Actions → Historical paper replay (checkpointed)** with:
- Date: `2026-11-12`
- Previous run ID: `43442196641`

The workflow uploads the discovery, screen, per-coin records, replay checkpoint and ranking output as one resumable artifact. To resume again, supply the most recent successful/partial workflow run ID that contains `pump-backtest-state-2026-11-12`.

## Coin selection: spend credits only where evidence justifies it

1. **Discover:** collect up to 100 time-stratified Pump launches across the Nairobi day, verifying each selected CreateEvent.
2. **Cheap screen:** request one bonding-curve signature page per discovered launch. Require at least five successful non-create signatures and activity in at least three distinct 10-second buckets. Score successful activity, active buckets and active span.
3. **Select:** rank the screened launches and retain at most the top 30% (maximum 30 when 100 launches are found). This is a deliberately activity-biased shortlist, not a random population sample.
4. **Deep replay:** process selected coins in batches of 20, but persist each coin as its own file, keyed by discovery index and mint. The shared checkpoint records the next candidate index and completed/incomplete outcomes. A coin is the atomic work unit: the runner reserves up to 122 credits before starting it (at most two signature pages plus 120 transaction fetches). If the remaining budget cannot cover that reserve, it stops before starting another coin. A budget-interrupted coin is not published as a completed coin artifact.
5. **Rank:** read only the selected coins in the matching discovery/screen/replay checkpoint for this date. Old or unrelated files in `artifacts/coins` cannot leak into the ranking.

The cheap screen is only an activity proxy. Signatures are not unique buyers, confirmed buy trades, verified volume, price movement, or proof of a sellable position. Deep replay independently decodes transactions and reconciles signatures, slots and block times; missing transactions, decode errors, truncation or unclassified successes keep that coin incomplete.

## First-30-second candidate filter

The ranking step evaluates SOL-quoted trade events from the CreateEvent block time through the first 30 seconds. The current thresholds are:
- At least 15 distinct buying wallets.
- At least 15 buy trades.
- At least 10% price appreciation from the first SOL-quoted buy to the final observed SOL-quoted trade in the 30-second window.
- At least 5 SOL of observed real SOL reserves at the end of that window.

Peak appreciation is reported as descriptive information; it does not substitute for the end-of-window price test. Reserve-derived price/liquidity are on-chain observations, not executable quotes.

## Outputs

- `artifacts/pump-launch-discovery-2026-11-12.json` — 100-bucket discovery and pagination checkpoint.
- `artifacts/pump-launch-screen-2026-11-12.json` — one-page activity screen and selected launch indexes.
- `artifacts/checkpoint.json` — deep-replay progress, per-coin outcomes and shared credit ledger.
- `artifacts/coins/NNNN-MINT.json` — individual decoded coin dataset, one file per selected launch.
- `artifacts/batch-summary-2026-11-12.json` — latest batch summary.
- `artifacts/pump-candidate-ranking-2026-11-12.json` — first-30-second candidate triage.

Artifacts are workflow artifacts, not Git commits. The workflow retains them for 30 days. Keep the most recent artifact run ID when resuming.

## What this dataset can and cannot tell us

This is a candidate-selection and entry-pattern dataset. It can tell us which launches showed early activity, verified trades, buyer counts, reserve changes and whether they passed the current screening thresholds. It cannot yet establish historical strategy win rate, expectancy, profit factor or live execution quality. It does not fabricate historical executable quotes, wallet/holder clearance, paper fills or verified exit fills. A qualified coin is a research candidate, not a buy instruction.

The top-30% activity selection introduces survivorship/activity bias. Do not use it to estimate how often all launches succeed. For strategy evaluation, preserve rejected and incomplete counts and later add a separately sampled control group, full timestamped wallet/holder evidence, fee-inclusive executable quote reconstruction, and verified entry/exit lifecycle replay.

The separate four-hour forward paper session remains blocked until the Worker-to-Neon ingestion, lease, restart recovery, persisted entry/exit and dashboard acceptance checks in `PAPER_TRADING_READINESS.md` pass. No real-wallet signing or live transaction submission is part of this workflow.


## Dashboard publication

After ranking (or after a bounded/partial run), the workflow idempotently publishes the date summary and up to 100 discovered launch rows to Neon using the GitHub Actions `DATABASE_URL` secret. The dashboard's **Historical launch research** panel reads those rows and shows discovery/screening counts, the selected shortlist, replay status, first-30-second buyers, price movement and observed real SOL reserves. Raw per-coin JSON and checkpoints remain in the GitHub Actions artifact as the authoritative detailed dataset; the dashboard is a searchable summary, not a replacement for the artifact.

The Neon schema must be migrated through `0010_historical_backtest_dashboard` before the replay workflow is run. The historical workflow validates `DATABASE_URL` before spending Helius credits and fails closed if the publishing credential is absent.
