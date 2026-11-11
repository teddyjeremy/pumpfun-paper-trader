# Roadmap

- [x] Safe paper-only project scope and invariants
- [x] Strict original strategy specification; experimental relaxed entry path excluded
- [x] Migration-aware holding and no-time-cap exit specification
- [x] Google Cloud worker deployment blueprint and systemd unit
- [x] Vercel project linked to the repository
- [ ] Verify current Pump.fun official SDK/program interfaces and implement launch decoder
- [ ] Helius stream adapter with reconnect, backfill and slot-lag measurement
- [x] Free-tier ingestion design and bounded RPC budget/priority queue primitives
- [ ] Pump.fun bonding-curve state reader and authoritative graduation detector
- [ ] Migrated-pool discovery and verified PumpSwap quote adapter
- [ ] Quote-only adapter with dynamic protocol/creator fee, network, priority, impact and slippage accounting
- [ ] Creator/linked-wallet/cluster evidence and hard rejection rules
- [ ] Exact original entry feature windows and explainable decisions
- [ ] PostgreSQL migrations, append-only event/trade ledger, idempotency and worker leader lease
- [ ] Deterministic paper executor and migration-aware position state machine
- [ ] Dynamic exhaustion exit signal backtest/calibration; no maximum holding duration
- [ ] Portfolio sizing/capacity policy and invariant tests
- [ ] Authenticated read-only Vercel dashboard backed by durable records
- [ ] Google Cloud resources, Secret Manager, monitoring, alerts, backups and budget guardrails
- [ ] Historical replay and paper-forward validation before any strategy changes

No implementation stage may bypass paper-only, strict-entry, fail-closed, no-fabricated-fill, or migration-aware exit invariants.
