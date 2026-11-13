# November 12 historical strategy replay

This run is paper-only and uses standard Helius RPC. It does not sign or submit transactions.

## Budget

The operator-approved initial ceiling is 100,000 Helius credits. The discovery phase defaults to 40,000 credits so approximately 60,000 remain for the per-launch transaction windows. Every standard `getSignaturesForAddress` and `getTransaction` request is counted as one credit. The scripts stop before making a request that would exceed their supplied ceiling. Requests are throttled to four per second.

A full-day scan is required before selecting the earliest 100 launches. If the 40,000-credit discovery cap is reached before the Nairobi day boundary is crossed, the artifact is marked `BUDGET_EXHAUSTED` and the replay script refuses to run. Do not treat a partial suffix of the day as the first 100 launches.

## Run on Windows PowerShell

Set the Helius key in the local process environment; never paste it into chat, source files, commits, or logs.

```powershell
$env:HELIUS_API_KEY = "<your Helius API key>"
npm run backtest:discover -- --date=2026-11-12 --utc-offset-minutes=180
npm run backtest:replay -- --date=2026-11-12 --max-credits=100000
```

The fixed +180-minute offset defines November 12 in Nairobi (Africa/Nairobi). The discovery script scans Pump.fun program-address history newest-to-oldest, verifies successful transaction logs, and retains the earliest 100 CreateEvents after it proves the full local day was traversed.

The replay script then scans each selected bonding curve for the first 600 seconds, capped at 120 signatures per launch, and fetches every successful signature. It requires exact signature, slot, and block-time reconciliation; any missing transaction, decoder issue, pagination truncation, or unclassified success leaves that launch incomplete. Confirmed failed signatures are counted from the signature index without a transaction fetch.

## Outputs and interpretation

- `artifacts/pump-launch-discovery-2026-11-12.json`
- `artifacts/pump-strategy-replay-2026-11-12.json`

Artifacts are local and ignored by Git. The runner records actual RPC credits consumed and refuses to exceed the total 100,000-credit ceiling.

The current replay evaluates historical price-volume and flow entry-pattern snapshots. It does **not** invent historical executable quotes, wallet/holder clearance, simulated fills, or verified exit lifecycle evidence. Therefore a `NO_SETUP` / `RISK_NOT_CLEARED` / incomplete classification is meaningful, but this run cannot yet establish profitable win rate, expectancy, or profit factor. Those require complete timestamped risk evidence and an execution/exit replay using verified fee-inclusive quotes.

The CLI is not a production deployment and does not start the live Worker. The November 12 artifact must be reviewed before any thresholds are changed. The 4-hour forward paper session is a separate test and remains blocked until the Worker-to-Neon ingestion and live entry/exit acceptance checks in `PAPER_TRADING_READINESS.md` pass.
