# Live paper-session runbook

Last reviewed: 2026-11-13

## Purpose and hard boundary

This runbook is for a forward-running, real-market-data paper session. It observes live launches and quotes, records simulated fills, and measures operational and strategy performance. It does **not** sign or submit Solana transactions and must never be described as live-money trading.

A four-hour run is an operational observation window, not proof of profitability. Do not start it until the final reviewed PR is deployed once and the production smoke checks below pass.

## Phase 0 — release and environment preflight

1. Confirm PR #77 is merged only after every required CI job passes on the exact reviewed head.
2. Apply the ordered Neon migrations, including the PR's new `0008` and `0009` migrations, against the intended production database; verify the migration ledger before deploying code that depends on them.
3. Perform the single planned Vercel and Cloudflare production deployment. Do not create repeated preview/production deployments during preparation.
4. Confirm the production Worker reports `mode=paper` and `tradingReady=false` until all runtime gates pass. A `true` value means system prerequisites only; it is not proof of a complete persisted trade lifecycle.
5. Confirm the production Worker and Vercel API use HTTPS.
6. Confirm these secrets are configured in their intended environments without printing or copying their values:
   - Worker: `CONTROL_TOKEN`, `HELIUS_API_KEY`, `PAPER_EVENT_INGEST_URL`, `PAPER_EVENT_INGEST_TOKEN`
   - Worker wallet-history collection: operator approved the bounded configuration on 2026-11-13: `FULL_WALLET_HISTORY_ENABLED=true`, `FULL_WALLET_HISTORY_MAX_PAGES=2`, at most 16 wallets per candidate refresh. Do not increase either cap or the refresh frequency without renewed approval. Monitor actual Helius credit use and stop collection if it exceeds the approved budget.
   - Vercel: `DATABASE_URL`, `PAPER_EVENT_INGEST_TOKEN`
   - Reviewed calibration: `REVIEWED_VOLUME_THRESHOLDS_JSON` only after a real, complete replay has been independently reviewed and approved. Do not fabricate this payload.
6. Verify the Neon migration version and that the dashboard read path can query session, position, quote and trade projections.
7. Run `npm run smoke:ingestion` only from an authorized environment containing `PAPER_WORKER_CONTROL_TOKEN`. The current Worker and API URLs have safe defaults; override them with `PAPER_WORKER_URL` or `PAPER_EVENT_INGEST_URL` only if the endpoints change. The authenticated Worker smoke endpoint uses the Worker's own ingestion secret to acquire/heartbeat its fenced Neon lease, persist a uniquely tagged `SESSION_STARTED`/`SESSION_STOPPED` audit-only session, and replay the same events to prove idempotency. It does not start market streams or create positions, quotes, fills, or transactions. The tagged smoke session remains in Neon for audit.
8. Require all checks to pass. HTTP 401/403/503, lease contention, missing migrations, unknown runtime state, or a secret mismatch is a stop condition.

## Phase 1 — paper-only lifecycle acceptance

Before the forward session, run the CI and integration suite and demonstrate against the deployed Worker/Neon environment:

- one candidate passes all 15 mandatory strategy rules using timestamped, complete evidence;
- a fresh exact-size BUY quote and exact-size SELL quote match mint, venue and quote mint, with exact-message fee evidence;
- account, ATA, rent, virtual payer, stake, fee and portfolio-reserve checks all pass;
- exactly one simulated entry is persisted;
- the scheduled exit obtains a fresh full-position SELL quote and persists exactly one simulated exit;
- retrying the same entry/exit request does not duplicate a fill or transition;
- two concurrent attempts cannot open duplicate positions or overspend the portfolio;
- a Worker restart restores the same open/closed position, balance, reserved rent and event sequence;
- Neon projections and dashboard values match the Worker ledger after reload;
- signing and transaction submission are absent/unavailable.

A direct Durable Object method test with in-memory storage is useful regression coverage but does not replace this deployed Worker-to-Neon acceptance test.

## Phase 2 — four-hour forward paper observation

Only after Phase 1 passes:

- Start a new isolated paper session with the configured virtual bankroll and one concurrent position.
- Observe live market data for four continuous hours. Do not top up real funds or connect a signing wallet.
- Keep the strategy rules, stake sizing, fee assumptions, quote TTL, slippage and exit rules frozen for the whole run. Record any configuration hash/version at session start.
- Record every candidate, including rejected and incomplete candidates, with first-seen time, source event, market venue, evidence coverage, reason codes and data freshness.
- Record quote attempts, quote failures, simulated entry/exit decisions, simulated fills, fees, price impact, latency, missed signals and blocked exits.
- Persist periodic health snapshots: stream connectivity, subscription acknowledgements, Helius queue depth, dropped/duplicate/failed signatures, incomplete candidates, coverage gaps, lease heartbeat, outbox cursor lag, last Neon acknowledgement and dashboard projection freshness.
- Verify the dashboard from a separate browser session at least at session start, after the first persisted trade, after a Worker restart, and at session end.
- Do not modify thresholds mid-session. If a rule needs changing, stop the run, preserve the artifacts, version the change and begin a new session.

## Immediate stop conditions

Stop the coordinator safely and preserve the session if any of these occur:

- mode is not paper, signing/submission capability appears, or readiness state is contradictory;
- discovery or Helius stream disconnects without a proven complete recovery interval;
- any mandatory strategy evidence is missing, stale, contradictory or UNKNOWN but treated as PASS;
- quote mint, venue, quote mint, amount, expiry or exact-message fee evidence does not match;
- sell quote is unavailable/stale for an open position, or the exit cannot be safely valued;
- Worker lease is lost, Neon ingestion fails, outbox lag grows without recovery, or persisted sequence skips;
- concurrent retry produces duplicate fills, negative cash, overspending, or inconsistent position state;
- dashboard and durable ledger disagree;
- an unexpected production error compromises data integrity.

Never force an entry or exit to keep the test running. A blocked exit remains an open risk and must remain visible as such.

## Phase 3 — session close and analysis

1. Stop the coordinator so no new provider messages are accepted.
2. Drain and acknowledge the durable outbox; record the final Neon sequence and lease release.
3. Export the complete session, candidate decisions, raw/decoded evidence references, quotes, simulated fills, fees, exits and health snapshots.
4. Reconcile Worker portfolio, Neon projections and dashboard: positions, quote IDs, trade IDs, cash, reserved rent, fees, realized/unrealized P&L and event sequence.
5. Report operational metrics separately from strategy metrics:
   - coverage completeness and gap duration;
   - candidate counts: discovered, screened, qualified, rejected, incomplete;
   - entries, exits, blocked entries/exits and quote failures;
   - simulated fill latency, slippage, price impact and fee drag;
   - gross and net P&L, win rate, expectancy, profit factor and drawdown only when the sample is adequate and every trade has complete evidence.
6. Preserve rejected and incomplete candidates. Do not calculate population-wide launch success rates from the top-30%-activity historical shortlist.
7. Compare frozen strategy variants only on chronological train/holdout periods. Do not tune against the same four-hour run and then report that run as out-of-sample validation.

## Promotion criteria

A successful four-hour operational session permits longer paper observation; it does not authorize real-money trading. Before considering any future live-money review, require multiple independent forward paper sessions, complete historical/forward wallet and holder evidence, fee-inclusive executable fills, stable restart/reconciliation, reviewed out-of-sample results and a separate explicit risk approval. This repository's paper trader remains non-signing and non-submitting.
