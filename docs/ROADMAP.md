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
- [x] Helius transaction verification adapter and bounded candidate-specific monitoring (10 slots, durable queue, event verification, and evidence-driven slot rotation)
- [ ] Verify Pump.fun official SDK/program interfaces and implement bonding-curve PDA/account decoder
- [ ] Authoritative graduation detector and migrated-pool discovery
- [ ] Helius backfill/reconciliation for missed provider events
- [ ] Complete entry decision engine and explainable decisions (strict per-rule evaluation and 1–2 second reclaim freshness confirmation are implemented; numeric volume-profile thresholds, executable quotes and automated ledger integration remain outstanding)
- [x] Exclude buy/sell spam at or below $0.01 from flow and price-volume evidence when a fresh SOL/USD price is supplied; pullback/reclaim volume ratios use buy-side quote volume only
- [ ] Add a fresh, validated SOL/USD price feed to the Worker; without it the micro-trade filter reports UNAVAILABLE and flow/volume evidence cannot pass
- [x] Direct creator-sale screening, bounded wallet-funding linkage inspection, and observed individual/linked-cluster hard rejects
- [ ] Complete wallet attribution and full holder census; current funding inspection is sampled and top-20 holder evidence is partial
- [ ] Verified PumpSwap quote adapter with dynamic protocol/creator fee, network, priority, impact and slippage accounting
- [x] Durable session journal core (append-only pages, idempotency, atomic session lifecycle, restart markers, pagination and JSON export); Durable Object runtime acceptance tests and six-hour soak remain outstanding
- [ ] PostgreSQL migrations, append-only event/trade ledger, idempotency and worker leader lease
- [ ] Deterministic paper executor and migration-aware position state machine
- [ ] Dynamic exhaustion exit signal backtest/calibration; no maximum holding duration
- [x] Paper portfolio sizing/capacity policy and pure accounting invariant tests (Worker quote/executor integration remains outstanding)
- [ ] Authenticated read-only Vercel dashboard backed by durable records
- [ ] Historical replay and paper-forward validation before any strategy changes

No implementation stage may bypass paper-only, strict-entry, fail-closed, no-fabricated-fill, or migration-aware exit invariants.
