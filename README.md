# Pump.fun Paper Trader

A **paper-only** Pump.fun research, market-monitoring and trading-simulation system. The project does not contain a wallet signer, submit Solana transactions, or execute real trades.

## Current implementation status

The repository has working foundations for discovery, verified market evidence, risk screening, historical backfill, persistence and strategy evaluation. It is **not yet trading-ready**: executable quotes and the strict entry rules are not fully connected to the paper execution lifecycle, and historical replay/calibration is still required.

### Implemented

- **Discovery:** PumpPortal launch/migration discovery with bounded, deduplicated candidate storage, expiry and reconnect/backoff handling.
- **Transaction verification:** candidate-specific Helius monitoring, bounded queues, shared RPC budgeting, verified Pump create/trade event decoding and explicit incomplete-data outcomes.
- **Historical recovery:** resumable Helius backfill with retry scheduling, session-scoped PostgreSQL checkpoints and archived verified transaction observations.
- **Market verification:** official Pump/PumpSwap IDL-aligned account decoders, PDA derivation, same-context account snapshots, canonical PumpSwap pool/vault checks and curve-to-migrated-market state transitions.
- **Risk evidence:** creator-sale screening, sampled wallet-funding links, wallet-cluster signals and scheduled top-holder concentration snapshots. Partial coverage remains UNKNOWN/incomplete, never a clearance.
- **Strategy evidence:** overlapping rolling trade-flow windows, unique buyer aggregation, price/volume profiles and strict per-rule strategy audit. Pullback/reclaim volume thresholds remain uncalibrated.
- **Paper accounting foundations:** portfolio sizing policy, durable session journal, PostgreSQL migrations, append-only audit/ledger projection, idempotency and worker lease primitives.
- **Quote foundations:** official Pump SDK offline curve/PumpSwap quote adapters and normalized executable-paper-quote validation. The converter enforces freshness, size-specific amounts, explicit costs, latency expiry and verified-zero transfer tax; it does not by itself authorize a fill.
- **Exit foundations:** protective and dynamic exit evaluators, 2/5/10/30-second evidence windows, quote-gated exit component and migration-aware position lifecycle primitives.
- **Operations:** read-only dashboard/API foundations, diagnostics, deployment blueprints and CI validation.

See [the detailed roadmap](docs/ROADMAP.md), [strategy specification](docs/STRATEGY.md), [migration and exits](docs/MIGRATION_AND_DYNAMIC_EXITS.md), and [operations guide](docs/OPERATIONS.md).

## What is not complete

1. **Executable quote integration:** complete non-zero Token-2022 transfer-fee support or explicitly reject unsupported mints; finalize authoritative live network/priority fee estimation, impact/slippage policy and quote economics; wire the official offline quote adapters to the verified same-slot market snapshots and paper execution.
2. **Entry authorization:** calculate and validate the complete impulse/pullback/reclaim volume profile, including calibrated contraction and expansion thresholds. Until thresholds are established by replay, the strict evaluator must remain WATCH/NOT READY rather than BUY.
3. **Position execution:** connect strategy decisions, fresh buy/sell quotes, deterministic simulated fills, the PostgreSQL position/trade ledger, and the dynamic exit scheduler. Enforce one entry per mint and release a slot only after a valid exit and confirmed zero token balance.
4. **Migration operations:** finish the end-to-end worker path that detects graduation, verifies the canonical PumpSwap market, refreshes full-position sell quotes and resumes exit monitoring without treating migration as a sell signal.
5. **Historical replay and calibration:** replay collected coins using the actual strategy rules and full fee/latency assumptions; report winners, losers, missed entries, false exits and rule-level reasons; calibrate on training data and validate on separate data.
6. **Runtime acceptance:** test Cloudflare Durable Object eviction/restart, PostgreSQL outages/recovery, worker lease fencing, queue recovery and provider gaps. Verify the deployed PumpPortal handshake and perform a bounded paper-forward soak.
7. **Dashboard completion:** expose the durable decision funnel, evidence coverage, quotes, positions, costs, PnL, exit blockers and provider health from persisted records.

No strategy threshold should be loosened merely to increase trade count. Missing, stale or contradictory critical evidence must fail closed.

## Paper portfolio policy

- Initial simulated equity: **$2.70**.
- Initial stake: **$1.00**.
- Initial maximum concurrent positions: **1**.
- Add one concurrent slot at each portfolio doubling (for example, $5 → 2 slots; $10 → 3 slots).
- Increase stake by 50% at each doubling, capped at **$100**.
- Never reuse a slot until the prior position has a valid simulated exit and zero token balance confirmation.
- Never buy the same mint more than once.
- Do not exceed available simulated equity after accounting for committed principal and costs.
- No maximum holding duration; migration is a market transition, not an automatic exit.

## Safety invariants

1. Paper mode is enforced. No wallet signer or transaction submission is part of the system.
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
- **Google Cloud:** persistent Node.js worker, PostgreSQL ledger, Secret Manager, logging/monitoring and archive/checkpoint blueprint. Cloud resources have not been provisioned by repository changes alone.
- **Vercel:** protected operator dashboard and read-only API surface; not the always-on market listener.

Deployment documentation: [infra/gcp/DEPLOYMENT.md](infra/gcp/DEPLOYMENT.md) and [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

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

The service must remain not-ready for paper execution until the verified quote path, strict entry evidence, risk gates, durable ledger and position/exit lifecycle are connected and tested. A successful CI run or multi-hour soak validates integration and operations, **not profitability**.

## Disclaimer

This is a research and simulation tool, not investment advice. Paper fills are estimates, not evidence of real-world profitability.
