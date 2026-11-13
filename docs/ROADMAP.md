# Roadmap

## Current release state

- Production remains on the older `main` build. PR #77 is the batched integration branch; do not deploy previews or merge until the exact final head passes CI and the production acceptance checks are ready.
- The system remains paper-only. No private wallet key, signing path, or on-chain transaction submission is part of this release.
- `tradingReady=false` remains mandatory until the full Worker → Neon → dashboard lifecycle is verified.

## Implemented in the PR #77 integration branch

- [x] Bounded PumpPortal launch/migration discovery and candidate-specific Helius monitoring.
- [x] Verified Pump CreateEvent/TradeEvent decoding, signature pagination integrity and resumable launch-window backfill.
- [x] Persist exact launch-window scan provenance and invalidate decode completion when its signature window changes.
- [x] Strict historical decode coverage: every signature must be verified or confirmed failed; every successful transaction must be acknowledged by Neon.
- [x] Complete holder-census implementation with stable repeated scans and exact token-supply reconciliation.
- [x] Bounded full wallet transaction-history collector, wallet-set completeness checks and timestamped risk evidence.
- [x] Exact-size unsigned Pump Curve/PumpSwap quote plans, fee evidence, rent/account checks and simulated portfolio authorization.
- [x] Worker-gated simulated entry and scheduled protective exit paths; portfolio reserves include both execution fee legs and rent.
- [x] Durable Object entry/exit/restart lifecycle tests and PostgreSQL outbox retry tests.
- [x] Dashboard read path for persisted paper-ledger positions, quotes and trades.
- [x] Historical strategy replay with chronological evidence, no future leakage and incomplete-lifecycle exclusion.
- [x] November 12 historical collection CLI: full-day Pump program scan, earliest-100 selection, 10-minute launch-window collection, shared 100,000-credit ceiling and local artifacts.
- [x] Worker recovers a WebSocket interruption only when the entire interval is inside a completed launch backfill and all successful transactions have Neon archive acknowledgements.

## Remaining before a real historical backtest

1. [ ] Execute the November 12 discovery and replay commands using the configured Helius key; record actual credit usage and the resulting local artifacts.
2. [ ] Extend gap recovery to interruptions outside the completed launch-window backfill. These intervals must remain incomplete until independently scanned, decoded and archived.
3. [ ] Add complete historical wallet/holder evidence and verified fee-inclusive entry/exit evidence to the replay before publishing profitability metrics.
4. [ ] Run chronological training/holdout calibration on complete data; require adequate sample sizes and both outcome classes. Never auto-promote thresholds.

## Remaining before the four-hour forward paper session

1. [ ] Resolve Worker-to-Vercel/Neon ingestion authentication. The API requires a strong service token; do not weaken the minimum or rotate the shared token without coordinated authorization for both environments.
2. [ ] Verify production migrations, database connectivity, fenced lease acquisition/renewal and an acknowledged paper-session event write.
3. [ ] Verify one real candidate passes all 15 mandatory rules, exact buy/sell quotes, fee/rent checks and portfolio capacity without bypasses.
4. [ ] Verify exactly one simulated entry and one simulated exit persist in Neon, survive Worker restart and match the dashboard after reload.
5. [ ] Complete contiguous event-stream provenance and independent gap recovery; incomplete streams must freeze new entries.
6. [ ] Finish supported-venue dynamic exit evidence: complete 2/5/10/30-second windows, PumpSwap trade decoding, holder-distribution time series and historical threshold calibration.
7. [ ] Review and merge the exact tested PR head, deploy once, then run production smoke tests in paper mode only.
8. [ ] Run the four-hour forward paper session and inspect coverage, execution errors, ledger reconciliation, drawdown and fee-inclusive results.

A four-hour run is an operational smoke test, not proof of profitability and not authorization for real-wallet trading. Any future live-trading proposal requires a separate explicit decision, security review and independent risk controls.

## Safety invariants

- Missing, stale, incomplete or unarchived evidence is never a pass.
- Top-20 holder snapshots and recent wallet samples are reject-only, not clean-risk clearance.
- No invented volume thresholds, execution costs, quotes or fills.
- Migration is not an automatic sell; blocked positions keep their portfolio slot.
- No live signing, private-key handling or transaction submission in this paper-trading release.
