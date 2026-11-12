# Pump.fun Paper Trader

A **paper-only** Pump.fun research, market-monitoring and trading-simulation system. It does not sign transactions, hold a wallet key, submit Solana transactions, or execute real trades.

## Repository status

The current `main` branch contains the discovery and monitoring foundation, verified Pump/PumpSwap account and transaction evidence, strict strategy audit, quote adapters, portfolio simulation primitives, and dashboard/API foundations.

**Main is not yet paper-trading ready.** The strict evaluator intentionally cannot authorize a BUY while the pullback/reclaim volume thresholds, executable quote economics, and quote-to-position lifecycle are incomplete.

### Implemented on main

- PumpPortal launch/migration discovery with bounded candidate storage and reconnect/expiry handling.
- Candidate-specific Helius monitoring, selective transaction verification, bounded queues/RPC budgeting and verified Pump create/trade decoding.
- Creator, holder and wallet-cluster risk evidence modules and price/volume/trade-flow profiling.
- Official Pump SDK offline curve and PumpSwap quote adapters using verified account snapshots.
- Normalized executable-paper-quote validation, fresh SOL/USD normalization, explicit fee fields, quote TTL and latency-expiry checks.
- Paper portfolio sizing, idempotent Durable Object session journal and position/exit primitives.
- PostgreSQL base schema/migration runner, audit-event ingestion and worker-lease primitives.
- Read-only dashboard/API and Cloudflare/GCP deployment blueprints.
- Dynamic exit evidence-family evaluator: correlated metrics are grouped, with either two independent families across two windows or one family persisting across three complete windows.

Relevant mainline work: [PR #34](https://github.com/teddyjeremy/pumpfun-paper-trader/pull/34), [PR #36](https://github.com/teddyjeremy/pumpfun-paper-trader/pull/36), [PR #39](https://github.com/teddyjeremy/pumpfun-paper-trader/pull/39).

### Integration work not yet promoted to main

A separate integration chain contains additional work that was merged into feature branches, **not into main**:

- [PR #19](https://github.com/teddyjeremy/pumpfun-paper-trader/pull/19): PostgreSQL paper-ledger projections and idempotent event projection.
- [PR #22](https://github.com/teddyjeremy/pumpfun-paper-trader/pull/22): resumable Helius backfill queue.
- [PR #24](https://github.com/teddyjeremy/pumpfun-paper-trader/pull/24): bounded Helius retry reconciliation and quote-gated dynamic-exit component.
- [PR #28](https://github.com/teddyjeremy/pumpfun-paper-trader/pull/28): PostgreSQL Helius backfill archive/checkpoints.
- [PR #31](https://github.com/teddyjeremy/pumpfun-paper-trader/pull/31): scheduled holder and wallet-link evidence collection.
- [PR #33](https://github.com/teddyjeremy/pumpfun-paper-trader/pull/33): one-second sampled overlapping trade-flow windows.
- [PR #37](https://github.com/teddyjeremy/pumpfun-paper-trader/pull/37) was closed because its stale feature-branch base created a large, conflicting diff against main. Its historical replay implementation still needs to be rebased and validated against current main.

These changes must not be described as deployed or merged into main until an integration PR is successfully rebased, CI-validated and merged.

## What remains

1. **Promote and validate the integration chain:** reconcile the PostgreSQL ledger, resumable backfill, Helius archive, retry and wallet/holder evidence changes with current main without overwriting newer mainline monitoring/quote work.
2. **Historical replay:** port the replay module and decode-coverage migration onto current main; replay the actual strict strategy chronologically using verified observations.
3. **Calibrate volume rules:** use chronological training/holdout sets to evaluate pullback contraction and reclaim expansion; do not invent thresholds or promote a weak holdout result.
4. **Complete quote economics:** add supported Token-2022 transfer-fee handling or fail-closed rejection, authoritative network/priority fee estimates, and validated impact/slippage policy.
5. **Connect paper execution:** wire fresh exact-size buy/sell quotes, strategy authorization, deterministic fills, persisted positions/trades and the dynamic exit scheduler.
6. **Complete migration lifecycle:** verify graduation and canonical PumpSwap market state, monitor full-position sellability and keep positions open when quotes are unavailable.
7. **Runtime acceptance:** test Durable Object eviction/restart, PostgreSQL outage/recovery, queue recovery, worker lease fencing, provider gaps and a bounded paper-forward soak.
8. **Dashboard completion:** expose persisted decisions, evidence coverage, quotes, open/closed positions, costs, PnL and exit blockers.

## Paper portfolio policy

- Initial simulated equity: **$2.70**.
- Initial stake: **$1.00**.
- Initial maximum concurrent positions: **1**.
- Add one concurrent slot at each portfolio doubling (for example, $5 → 2 slots; $10 → 3 slots).
- Increase stake by 50% at each doubling, capped at **$100**.
- Never reuse a slot until the prior position has a valid simulated exit and zero token balance confirmation.
- Never buy the same mint more than once.
- Do not exceed available simulated equity after committed principal and costs.
- No maximum holding duration; migration is a market transition, not an automatic exit.

## Safety invariants

1. Paper mode only. No wallet signer or transaction submission.
2. Only verified, non-migrated Pump.fun bonding-curve tokens may be entered.
3. A held token may migrate; keep the position open until its migrated market is verified and the exit policy produces a valid quote.
4. Missing risk evidence, incomplete backfill, stale market data, unknown costs, unsupported token extensions or failed sellability checks block entry.
5. Never fabricate a fill from chart prices, reserve-delta proxies or stale quotes.
6. Account using raw integer base units and decimal-safe arithmetic.
7. Idempotency and worker lease fencing prevent duplicate entries/exits.
8. A migration or quote outage never silently closes a position or releases a slot.
9. A global paper kill switch blocks new entries while preserving management of open positions.

## Deployment layout

- **Cloudflare Worker / Durable Object:** bounded discovery, candidate monitoring and resumable coordination primitives.
- **Google Cloud:** persistent Node.js worker, PostgreSQL ledger, Secret Manager, logging/monitoring and archive/checkpoint blueprint. Resources are not provisioned by repository changes alone.
- **Vercel:** protected operator dashboard and read-only API; not the always-on market listener.

## Development

- Node.js 22
- TypeScript strict mode
- Fastify, Zod and Pino
- Vitest
- PostgreSQL

```bash
npm install
npm run dev
npm run typecheck
npm test
npm run build
```

## Readiness

The service must remain not-ready for paper execution until the verified quote path, strict entry evidence, risk gates, durable ledger and position/exit lifecycle are connected and tested. CI and a multi-hour soak validate integration and operations, **not profitability**.

## Disclaimer

This is a research and simulation tool, not investment advice. Paper fills are estimates, not evidence of real-world profitability.
