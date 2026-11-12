# Roadmap

## Current main branch

- [x] Safe paper-only scope and invariants
- [x] PumpPortal launch/migration discovery and bounded candidate store
- [x] Candidate-specific Helius monitoring and verified Pump event decoding
- [x] Creator, holder and wallet-cluster risk evidence foundations
- [x] Price/volume and overlapping trade-flow evidence foundations
- [x] Official Pump SDK offline curve and PumpSwap quote adapters
- [x] Normalized executable-paper-quote converter with freshness, cost fields and latency expiry checks
- [x] Portfolio sizing and Durable Object session-journal primitives
- [x] PostgreSQL base migrations, audit ingestion and worker lease primitives
- [x] Dynamic exit evidence-family evaluator with correlated-signal grouping and two confirmation paths
- [x] Read-only dashboard/API and deployment blueprints

## Recently merged integration — PR #40

These components are already on current `main`:

- [x] PostgreSQL paper-ledger projections and idempotent event projection.
- [x] Resumable Helius backfill queue, bounded transient retries, checkpoints and verified transaction archive.
- [x] Scheduled holder and wallet-link evidence collection with incomplete/stale handling.
- [x] One-second sampled overlapping flow windows and distinct buyer aggregation.
- [x] Strict strategy-to-paper execution and quote-gated exit lifecycle primitives.

## Remaining implementation

1. [x] Integrate PostgreSQL ledger projections, Helius backfill archive/checkpoints and resumable retry queue into main.
2. [x] Implement chronological historical price/volume and rolling-flow replay, verified archive hydration, decode-completeness gating and authenticated read-only replay/backfill APIs (PR #45, merged).
3. [x] Extend historical replay with creator-sale and wallet-cluster risk statuses, separate market-pattern candidates from risk-cleared candidates, and prevent future-evidence leakage (PR #48, merged).
4. [ ] Run replay against collected sessions and calibrate pullback contraction/reclaim expansion with chronological training and holdout data. Require adequate sample sizes and both outcome classes; never auto-promote thresholds.
5. [ ] Complete Token-2022 transfer-fee handling or explicit fail-closed rejection, authoritative network/priority fee estimation and validated impact/slippage policy. Current paper-entry and paper-exit boundaries enforce <=2% per-side price impact; entry also enforces <=4% combined buy/sell fees.
6. [ ] Connect the reusable quote-gated lifecycle to the Worker position scheduler and persist deterministic paper entry/exit transitions.
7. [ ] Connect dynamic exit evaluation to the position scheduler and exact full-position sell quotes.
8. [ ] Complete authoritative migration detection, canonical PumpSwap pool monitoring and exit-blocked recovery.
9. [ ] Test Durable Object eviction/restart, PostgreSQL outages/recovery, queue recovery, provider gaps and lease fencing.
10. [x] Add authenticated Worker status proxy, combined read-only snapshot and live discovery monitor controls to the dashboard (PR #49, pending CI).
11. [ ] Complete dashboard consumption of persisted decisions, simulated fills, open positions and exits.
12. [ ] Run bounded paper-forward validation before considering any readiness change.

## Safety gates

- Never treat missing or stale evidence as a pass.
- Never invent volume thresholds, transaction fees, executable quotes or fills.
- Migration is not an automatic sell.
- A position slot is released only after a valid simulated exit and zero token balance confirmation.
- No live signing, transaction submission or production deployment is permitted by this roadmap.
