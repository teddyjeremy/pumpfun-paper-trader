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

## Integration branch work — not yet in main

The following PRs were merged into the separate feature integration chain. They are not part of the current main branch yet:

- [ ] Promote PR #19 PostgreSQL paper-ledger projections and idempotent event projection.
- [ ] Promote PR #22 resumable Helius backfill queue.
- [ ] Promote PR #24 bounded retry reconciliation and quote-gated dynamic-exit component.
- [ ] Promote PR #28 PostgreSQL Helius archive and session checkpoints.
- [ ] Promote PR #31 scheduled holder and wallet-link evidence collection.
- [ ] Promote PR #33 one-second sampled overlapping trade-flow windows.
- [ ] Rebase PR #37 historical replay and decode-coverage migration onto current main; the old PR was closed because its stale base produced a large conflicting diff.

## Remaining implementation

1. [ ] Integrate PostgreSQL ledger projections, Helius backfill archive/checkpoints and resumable retry queue into main. Preserve the current mainline candidate monitoring, official SDK quote adapters and latest exit-evidence fix.
2. [ ] Port historical replay with verified archived transaction hydration and explicit transaction-decoding completeness.
3. [ ] Replay the complete strict strategy: impulse, pullback, reclaim, rolling flow, creator/cluster risk, signal freshness, and pullback/reclaim volume profile.
4. [ ] Calibrate pullback contraction and reclaim expansion with chronological training and holdout data. Require adequate sample sizes and both outcome classes; never auto-promote thresholds.
5. [ ] Complete Token-2022 transfer-fee support or fail-closed rejection, network/priority fee estimation and impact/slippage policy.
6. [ ] Wire quote generation and strict strategy authorization into deterministic paper entry/exit transitions and PostgreSQL persistence.
7. [ ] Connect dynamic exit evaluation to the position scheduler and exact full-position sell quotes.
8. [ ] Complete authoritative migration detection, canonical PumpSwap pool monitoring and exit-blocked recovery.
9. [ ] Test Durable Object eviction/restart, PostgreSQL outages/recovery, queue recovery, provider gaps and lease fencing.
10. [ ] Complete authenticated dashboard consumption of persisted decisions, quotes, trades and positions.
11. [ ] Run bounded paper-forward validation before considering any readiness change.

## Safety gates

- Never treat missing or stale evidence as a pass.
- Never invent volume thresholds, transaction fees, executable quotes or fills.
- Migration is not an automatic sell.
- A position slot is released only after a valid simulated exit and zero token balance confirmation.
- No live signing, transaction submission or production deployment is permitted by this roadmap.
