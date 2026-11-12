# Pump.fun Paper Trader

A **paper-only** Pump.fun research, market-monitoring and trading-simulation system. It does not sign transactions, hold a wallet key, submit Solana transactions, or execute real trades.

## Repository status

The current `main` branch contains the discovery and monitoring foundation, verified Pump/PumpSwap account and transaction evidence, strict strategy audit, quote adapters, portfolio simulation primitives, and dashboard/API foundations.

**Main is not yet paper-trading ready.** The merged ledger and reusable execution components are not yet connected to an automatic position scheduler, and strict entry remains fail-closed. The strict evaluator intentionally cannot authorize a BUY while the pullback/reclaim volume thresholds, executable quote economics, and quote-to-position lifecycle are incomplete.

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

### Integrated paper-trading stack (merged PR #40)

This branch promotes the previously feature-branch-only work into mainline as one tested integration:

- PostgreSQL paper-ledger projections and idempotent event projection (PR #19 work).
- Resumable Helius backfill queue and bounded transient retries (PR #22/#24 work).
- Session-scoped Helius backfill checkpoints and verified transaction archive (PR #28 work).
- Scheduled holder and wallet-link evidence collection with explicit incomplete/stale handling (PR #31 work).
- One-second sampled overlapping flow windows and distinct buyer aggregation (PR #33 work).
- Strict strategy-to-paper execution lifecycle and reusable quote-gated dynamic exit component.

The integration was merged in [PR #40](https://github.com/teddyjeremy/pumpfun-paper-trader/pull/40). The historical replay foundation, decode-completeness tracking and read-only replay API are included in [PR #45](https://github.com/teddyjeremy/pumpfun-paper-trader/pull/45). The replay still does not simulate the complete strategy or executable fills; calibration remains advisory.

## What remains

1. **Validate historical replay:** run the new replay API against collected sessions, inspect incomplete-coverage outcomes and verify that archived observations match the intended launch windows. Migration 0007 is additive and must be explicitly reviewed/applied before the replay API can read decode-completeness fields.
2. **Complete strategy replay and calibration:** include every mandatory rule and the documented dynamic exit behavior; use chronological training/holdout sets to evaluate pullback contraction and reclaim expansion. Do not invent thresholds or promote a weak holdout result.
3. **Complete quote economics:** add supported Token-2022 transfer-fee handling or fail-closed rejection, authoritative network/priority fee estimates, and validated impact/slippage policy.
4. **Connect paper execution:** connect quote-gated entry/exit lifecycle to the actual Worker position scheduler and persist complete position/trade transitions.
5. **Complete migration lifecycle:** verify graduation and canonical PumpSwap market state, monitor full-position sellability and keep positions open when quotes are unavailable.
6. **Runtime acceptance:** test Durable Object eviction/restart, PostgreSQL outage/recovery, queue recovery, worker lease fencing, provider gaps and a bounded paper-forward soak.
7. **Dashboard completion:** expose persisted decisions, evidence coverage, quotes, open/closed positions, costs, PnL and exit blockers.

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
