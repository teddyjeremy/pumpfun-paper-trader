# November 12 historical strategy replay

This run is paper-only and uses standard Helius RPC. It does not sign or submit transactions.

## Budget

The operator-approved initial ceiling is 100,000 Helius credits. The previous standard-RPC discovery attempt consumed 16,778 credits before failing while retaining millions of signatures in memory; that sunk usage is carried forward in `legacyPriorCreditsUsed` and is not repeated. The replacement discovery uses Helius Parsed Events Scan with exact time bounds and only the Pump `create`/`create_v2` instructions. It divides the Nairobi day into 100 equal-width time buckets, scans at most five 10,000-transaction pages per bucket, and independently fetches/decodes only one selected Create transaction per non-empty bucket. The new Parsed Events discovery ceiling is 5,000 credits, the signature-screen ceiling is 500 credits, and the shared end-to-end Helius credit ceiling (including replay) is 30,000 credits. The previous 16,778-credit failed crawl is included in that shared ceiling. Every response's `scan.creditsCharged` is counted; incomplete cursors are persisted and resumable. Parsed Events Scan is a paid-plan/beta capability; if the API key cannot access it, the workflow stops immediately and does not fall back to the expensive unbounded standard-RPC crawl.

The time-bucket sample must finish all 100 bounded queries before the artifact is marked `SAMPLE_COMPLETE`. A bucket that hits its five-page scan cap without finding a Create instruction is `INCOMPLETE`, never classified as empty. A later workflow run can restore the artifact and resume from the saved bucket/pagination cursor. The old 16,778-credit standard-RPC crawl is retained as sunk historical spend only; its partial result is never used as a launch sample.

## Run on Windows PowerShell

Set the Helius key in the local process environment; never paste it into chat, source files, commits, or logs.

```powershell
$env:HELIUS_API_KEY = "<your Helius API key>"
npm run backtest:discover -- --date=2026-11-12 --utc-offset-minutes=180
npm run backtest:replay -- --date=2026-11-12 --max-credits=100000
```

The fixed +180-minute offset defines November 12 in Nairobi (Africa/Nairobi). The discovery script uses Helius's server-side Parsed Events Scan to match Pump `create` and `create_v2` instructions inside each exact time bucket, then verifies the selected signature, slot, block time, successful transaction logs, and decoded CreateEvent using the raw transaction.

The workflow first screens every discovered bonding curve with one `getSignaturesForAddress` page (one additional RPC credit per launch). It ranks the top 30% by successful signature activity, activity across distinct 10-second buckets, and active span. Coins need at least five successful non-create signatures across at least three time buckets to qualify. The screening checkpoint is written after each coin, so a later workflow run can resume without repeating completed screens. Only selected candidates proceed to full 600-second collection and transaction decoding, capped at 120 signatures per launch. It requires exact signature, slot, and block-time reconciliation; any missing transaction, decoder issue, pagination truncation, or unclassified success leaves that launch incomplete. Confirmed failed signatures are counted from the signature index without a transaction fetch.

## Outputs and interpretation

- `artifacts/pump-launch-discovery-2026-11-12.json`
- `artifacts/pump-launch-screen-2026-11-12.json` (resumable activity-screen checkpoint and selected launch indexes)
- `artifacts/pump-strategy-replay-2026-11-12.json`
- `artifacts/pump-candidate-ranking-2026-11-12.json` (strict first-30-second buyer/activity/liquidity qualification)
- `artifacts/pump-candidate-ranking-2026-11-12.json` (verified first-30-second trade qualification)

Artifacts are local and ignored by Git. The runner records actual RPC credits consumed and refuses to exceed the total 100,000-credit ceiling.

The screen is intentionally a cheap activity proxy: signatures are not unique buyers, trade direction, verified volume, or proof of price movement. After detailed decoding, the ranking step evaluates only the true first 30 seconds after each launch and requires at least 15 distinct buying wallets, 15 buy trades, at least 10% peak reserve-price movement, and at least 5 SOL of observed real SOL reserves. It records buy/sell counts, buy SOL volume, close-to-window price movement, peak movement, and reserve liquidity, and labels incomplete histories separately. These are triage thresholds derived from the current strategy's early-activity requirements, not a profitability claim. The selected top-30% sample is activity-biased and must not be used as a representative population estimate. After full decode, the workflow separately qualifies actual SOL-quoted trades in the first 30 seconds: at least 15 unique buyers, at least 15 buy trades, at least 10% peak reserve-price rise, and at least 5 SOL of observed real SOL reserves. This is a candidate filter based on on-chain event observations, not proof of executable fills or profitability. The current replay evaluates historical price-volume and flow entry-pattern snapshots. It does **not** invent historical executable quotes, wallet/holder clearance, simulated fills, or verified exit lifecycle evidence. Therefore a `NO_SETUP` / `RISK_NOT_CLEARED` / incomplete classification is meaningful, but this run cannot yet establish profitable win rate, expectancy, or profit factor. Those require complete timestamped risk evidence and an execution/exit replay using verified fee-inclusive quotes.

The CLI is not a production deployment and does not start the live Worker. The November 12 artifact must be reviewed before any thresholds are changed. The 4-hour forward paper session is a separate test and remains blocked until the Worker-to-Neon ingestion and live entry/exit acceptance checks in `PAPER_TRADING_READINESS.md` pass.
