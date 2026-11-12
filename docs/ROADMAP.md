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
- [x] Verify official Pump program and PumpSwap IDL layouts; implement fail-closed bonding-curve and pool/vault account decoders (PDA derivation remains delegated to the official SDK)
- [ ] Authoritative graduation detector, official-SDK PDA derivation, and Worker/position integration (bounded PumpSwap pool discovery by base mint and same-slot vault re-fetch primitives are implemented)
- [x] Pure fail-closed market transition rules for live curve, migration pending, verified canonical pool and EXIT_BLOCKED
- [x] IDL-aligned Pump curve, PumpSwap pool, and SPL token-vault decoders with program-owner, discriminator, mint, vault, canonical index/authority, slot-coherence and freshness checks
- [x] Helius getMultipleAccounts reader that returns related account data from one shared RPC context slot
- [x] Pure adapter that passes verified curve and canonical pool/vault snapshots into the migration-aware market state machine
- [x] Bounded PumpSwap pool discovery by base mint, followed by canonical pool/vault verification
- [ ] Helius backfill/reconciliation for missed provider events
- [ ] Complete entry decision engine and explainable decisions (strict per-rule evaluation and 1–2 second reclaim freshness confirmation are implemented; numeric volume-profile thresholds, executable quotes and automated ledger integration remain outstanding)
- [x] Exclude buy/sell spam at or below $0.01 from flow and price-volume evidence when a fresh SOL/USD price is supplied; pullback/reclaim volume ratios use buy-side quote volume only
- [x] Fetch and validate fresh SOL/USDT last-trade reference data for USD-notional spam filtering; reject stale, malformed or unavailable observations (not an execution price)
- [x] Direct creator-sale screening, bounded wallet-funding linkage inspection, and observed individual/linked-cluster hard rejects
- [ ] Complete wallet attribution and full holder census; current funding inspection is sampled and top-20 holder evidence is partial
- [ ] Verified Pump/PumpSwap executable quote adapter using official SDK quote math, dynamic protocol/creator fees, network/priority costs, impact and slippage accounting
- [x] Durable session journal core (append-only pages, idempotency, atomic session lifecycle, restart markers, pagination and JSON export)
- [x] Durable Object journal storage-contract tests for concurrent appends, monotonic paging, idempotency, rollback and restart markers; real Cloudflare runtime acceptance tests and six-hour soak remain outstanding
- [ ] PostgreSQL event/trade ledger writes, idempotent execution transitions and worker lease integration (ordered migrations and an explicit manual migration runner are implemented)
- [ ] Deterministic paper executor and migration-aware position state machine
- [x] Dynamic exit-window metric builder for verified 2/5/10/30-second samples, with baseline resets across gaps/venue/phase/quote changes
- [ ] Dynamic exhaustion exit signal backtest/calibration and Worker quote-gated position integration; no maximum holding duration
- [x] Paper portfolio sizing/capacity policy and pure accounting invariant tests (Worker quote/executor integration remains outstanding)
- [ ] Authenticated read-only Vercel dashboard backed by durable records
- [ ] Historical replay and paper-forward validation before any strategy changes

No implementation stage may bypass paper-only, strict-entry, fail-closed, no-fabricated-fill, or migration-aware exit invariants.
