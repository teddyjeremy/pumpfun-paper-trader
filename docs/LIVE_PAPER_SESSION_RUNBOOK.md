# Live paper-session runbook

Last reviewed: 2026-11-14

## Purpose and hard boundary

This runbook is for a forward-running, real-market-data paper session. It observes live launches and quotes, records simulated fills, and measures operational and strategy performance. It does **not** sign or submit Solana transactions and must never be described as live-money trading.

A four-hour run is an operational observation window, not proof of profitability. Do not start it until the final reviewed PR is deployed once and the production smoke checks below pass.

## Phase 0 — release and environment preflight

1. PR #77 (Worker readiness), PR #78 (historical dashboard integration), and PR #81 (consolidated ingestion/replay readiness) are merged. The PR #81 merge commit is `463fec5b50ea5a7f97526ea51cc838c7fdec766d`; its Cloudflare Worker deployment succeeded in [run 43492860300](https://github.com/teddyjeremy/pumpfun-paper-trader/actions/runs/43492860300).
2. The ordered Neon migration workflow completed successfully in [run 43487821121](https://github.com/teddyjeremy/pumpfun-paper-trader/actions/runs/43487821121), applying the pending migrations through `0010`. Verify the production migration ledger and database connectivity during acceptance; do not rerun migrations unless the workflow identifies pending migrations.
3. The required Vercel and Cloudflare releases are already deployed. Do not trigger another production deployment for documentation-only changes or repeatedly redeploy during preparation.
4. Confirm the production Worker reports `mode=paper` and `tradingReady=false` until all runtime gates pass. A `true` value means system prerequisites only; it is not proof of a complete persisted trade lifecycle.
5. Confirm the production Worker and Vercel API use HTTPS.
6. Confirm these secrets are configured in their intended environments without printing or copying their values:
   - Worker: `CONTROL_TOKEN`, `HELIUS_API_KEY`, `PAPER_EVENT_INGEST_URL`, `PAPER_EVENT_INGEST_TOKEN`
   - Worker wallet-history collection: operator approved the bounded configuration on 2026-11-13: `FULL_WALLET_HISTORY_ENABLED=true`, `FULL_WALLET_HISTORY_MAX_PAGES=2`, at most 16 wallets per candidate refresh. Do not increase either cap or the refresh frequency without renewed approval. Monitor actual Helius credit use and stop collection if it exceeds the approved budget.
   - Vercel: `DATABASE_URL`, `PAPER_EVENT_INGEST_TOKEN`
   - Reviewed calibration: `REVIEWED_VOLUME_THRESHOLDS_JSON` only after a real, complete replay has been independently reviewed and approved. Do not fabricate this payload.
6. Verify the Neon migration version and that the dashboard read path can query session, position, quote and trade projections.
7. Run the **Production Worker-to-Neon smoke** GitHub Actions workflow (or `npm run smoke:ingestion` from an authorized environment containing `PAPER_WORKER_CONTROL_TOKEN`). The current Worker and API URLs have safe defaults; override them with `PAPER_WORKER_URL` or `PAPER_EVENT_INGEST_URL` only if the endpoints change. The authenticated Worker smoke endpoint uses the Worker's own ingestion secret to acquire/heartbeat its fenced Neon lease, persist a uniquely tagged `SESSION_STARTED`/`SESSION_STOPPED` audit-only session, and replay the same events to prove idempotency. It does not start market streams or create positions, quotes, fills, or transactions. The tagged smoke session remains in Neon for audit.
8. Require all checks to pass. HTTP 401/403/503, lease contention, missing migrations, unknown runtime state, or a secret mismatch is a stop condition.

## Phase 1 — paper-only lifecycle acceptance

Historical replay is now available for Nov 11 and Nov 12 using bounded, activity-ranked samples (20 and 30 selected launches respectively). The corrected ranking recognizes both wrapped-SOL and legacy native-SOL quote mints. Nov 11 has 17 complete coins, 3 incomplete and 1 activity-qualified coin; its strategy replay returned `NO_SETUP`, so it is not a strategy entry. Nov 12 has 27 complete coins, 3 incomplete and 0 activity-qualified coins under the current thresholds. These are pre-qualification results, not profitability or win-rate evidence. The corrected artifacts and dashboard publication are in [Nov 11 rerank run 43568187060](https://github.com/teddyjeremy/pumpfun-paper-trader/actions/runs/43568187060) and [Nov 12 rerank run 43568059148](https://github.com/teddyjeremy/pumpfun-paper-trader/actions/runs/43568059148). Reranking restores those artifacts and makes no Helius calls. Full historical replay workflows are manual-dispatch only; never start a new replay from a stale checkpoint or trigger one merely by editing ingestion code.


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

### PostgreSQL lease and queue-drain safeguards

The coordinator's fenced Neon lease uses a 120-second TTL. It renews before and after Helius queue work and after persistence flushes. Each Helius drain is bounded to five work items; pending work schedules another alarm rather than monopolizing one Durable Object invocation. A lost lease remains a fail-closed stop condition. The production Worker-to-Neon smoke passed in [run 43568650219](https://github.com/teddyjeremy/pumpfun-paper-trader/actions/runs/43568650219), but that short smoke is not a substitute for a sustained forward-session lease/stream acceptance run.

**Current safety pause (Nov 14, 2026):** Cloudflare Durable Objects GraphQL analytics for namespace `pumpfun-paper-worker_PumpFunCoordinator` reported **561,822 `rowsWritten` and 309,147 `rowsRead`** on Nov 14 through 07:21:40 UTC. The Free-plan daily allowance is 100,000 written rows. The largest one-minute bucket was **108,027 rows written at 07:05:10 UTC**; two adjacent buckets were 107,634 and 100,455. No further Durable Object periodic or invocation groups were returned after 07:25 UTC in the queried window. The quota-exhaustion failures were visible in the 07:11 production smoke, which received HTTP 500 from Worker `/health` ([run 43569881522](https://github.com/teddyjeremy/pumpfun-paper-trader/actions/runs/43569881522)). `PAPER_WORKER_PAUSED=true` remains deployed; public health/status use a static disabled response and the scheduled handler returns before invoking the Durable Object. The latest Cloudflare settings inspection confirmed `PAPER_ENABLE_HISTORICAL_BACKFILL=false` and `PAPER_ENABLE_GAP_RECOVERY=false`. Do not unpause or start another observation session until a controlled write-budget acceptance test passes.

**Write-amplification root cause and remediation:** the earlier `recordCandidateTradePrice` path wrote five Durable Object keys for every trade sample (audit page, event-ID index, session metadata, tracker, and processed marker). The Helius drain also rewrote its monitor/verified-transaction/status snapshot for individual queue items. The new candidate-price path keeps samples in memory and checkpoints tracker state plus processed IDs together; Helius queue progress now marks the state dirty and is checkpointed in bounded batches. `PERSIST_EVERY_EVENTS` is 500, the periodic checkpoint interval is five minutes, verified-transaction snapshots are capped at 500, and automatic historical backfill/gap recovery are disabled in forward mode. These changes materially reduce writes, but the production metrics above show why the new code still needs a measured, short-duration acceptance test before resuming.

The latest CI on the current workflow revision passed in [run 43572572664](https://github.com/teddyjeremy/pumpfun-paper-trader/actions/runs/43572572664). Cloudflare has a current deployment with the pause still set to `true` (Nov 14 07:49 UTC). The cron trigger remains configured every minute, but the paused scheduled handler exits before making a Durable Object call. A forward-observation start did previously succeed at 07:00 UTC, but the verification found `Paper event ingestion failed` despite both streams and the Neon lease appearing connected ([run 43569034604](https://github.com/teddyjeremy/pumpfun-paper-trader/actions/runs/43569034604)); a later smoke failed with HTTP 500. Therefore neither the earlier smoke successes nor green CI constitute sustained production persistence acceptance.

The [post-reset finalization workflow](../.github/workflows/finalize-paused-paper-session.yml) is scheduled for Nov 15 at 00:05 UTC; it persists the previous session as stopped while keeping the Worker paused. It does not automatically resume observation.

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
