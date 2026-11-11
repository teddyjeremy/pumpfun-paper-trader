# Roadmap

- [x] Safe paper-only project scope and invariants
- [x] Strict original strategy specification; experimental relaxed entry path excluded
- [x] Migration-aware holding and no-time-cap exit specification
- [x] Google Cloud worker deployment blueprint and systemd unit
- [x] Vercel project linked to the repository
- [x] Free-tier ingestion design, bounded RPC budget/priority queue primitives, Pump.fun event decoders, and PumpPortal discovery parser
- [x] Bounded Durable Object discovery candidate store with mint deduplication, migration updates, expiry, overflow counters, and batched persistence
- [x] Replace global Pump.fun logs listener with PumpPortal launch/migration discovery subscriptions
- [ ] Verify no-key PumpPortal WebSocket handshake in the deployed Worker
- [ ] Add reconnect/backoff and provider-gap reconciliation
- [ ] Helius transaction verification adapter and selective account monitoring
- [ ] Verify Pump.fun official SDK/program interfaces and implement bonding-curve PDA/account decoder
- [ ] Authoritative graduation detector and migrated-pool discovery
- [ ] Helius backfill/reconciliation for missed provider events
- [ ] Exact original entry observation windows and explainable decisions
- [ ] Creator/linked-wallet/cluster evidence and hard rejection rules
- [ ] Verified PumpSwap quote adapter with dynamic protocol/creator fee, network, priority, impact and slippage accounting
- [ ] PostgreSQL migrations, append-only event/trade ledger, idempotency and worker leader lease
- [ ] Deterministic paper executor and migration-aware position state machine
- [ ] Dynamic exhaustion exit signal backtest/calibration; no maximum holding duration
- [ ] Portfolio sizing/capacity policy and invariant tests
- [ ] Authenticated read-only Vercel dashboard backed by durable records
- [ ] Historical replay and paper-forward validation before any strategy changes

No implementation stage may bypass paper-only, strict-entry, fail-closed, no-fabricated-fill, or migration-aware exit invariants.
