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
- [x] Verify official Pump program and PumpSwap IDL layouts; implement fail-closed bonding-curve and pool/vault account decoders with PDA derivation from official IDL seeds
- [ ] Worker/position integration and retry scheduling (Helius-backed curve-to-pool verification, bounded discovery, same-slot vault re-fetch, and IDL-seed PDA derivation are implemented)
- [x] Pure fail-closed market transition rules for live curve, migration pending, verified canonical pool and EXIT_BLOCKED
- [x] IDL-aligned Pump curve, PumpSwap pool, and SPL token-vault decoders with program-owner, discriminator, mint, vault, canonical index/authority, slot-coherence and freshness checks
- [x] Helius getMultipleAccounts reader that returns related account data from one shared RPC context slot
- [x] Pure adapter that passes verified curve and canonical pool/vault snapshots into the migration-aware market state machine
- [x] Helius-backed market refresh pipeline: fetch curve PDA, stop at LIVE_CURVE, or on completion discover index-0 canonical PumpSwap pool and verify pool plus both vaults at one RPC context slot
- [x] Bounded PumpSwap pool discovery by base mint, followed by canonical pool/vault verification
- [ ] Helius backfill/reconciliation for missed provider events
- [ ] Complete entry decision engine and explainable decisions (strict per-rule evaluation and 1–2 second reclaim freshness confirmation are implemented; numeric volume-profile thresholds, executable quotes and automated ledger integration remain outstanding)
- [x] Exclude buy/sell spam at or below $0.01 from flow and price-volume evidence when a fresh SOL/USD price is supplied; pullback/reclaim volume ratios use buy-side quote volume only
- [x] Fetch and validate fresh SOL/USDT last-trade reference data for USD-notional spam filtering; reject stale, malformed or unavailable observations (not an execution price)
- [x] Direct creator-sale screening, bounded wallet-funding linkage inspection, and observed individual/linked-cluster hard rejects
- [ ] Complete wallet attribution and full holder census; current funding inspection is sampled and top-20 holder evidence is partial
- [ ] Verified Pump/PumpSwap executable quote adapter using official SDK quote math, dynamic protocol/creator fees, network/priority costs, impact and slippage accounting (offline curve/AMM quotes and a USD cost/latency normalizer are implemented; non-zero transfer-fee support, production fee estimation and Worker wiring remain)
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

## Official Pump SDK quote adapter
- Added the official `@pump-fun/pump-sdk@4.3.1` dependency. The published package now includes the PumpSwap SDK at `@pump-fun/pump-sdk/swap`; do not add a duplicate standalone AMM SDK.
- Dependency installation, typecheck, tests/build and Worker bundle validation passed after adding the official package (CI run 43185228566). A direct Vitest runtime import smoke test exposed Anchor CommonJS/ESM interop incompatibility and was removed. The Worker now imports both SDK entry points and reports module availability; its bundle compatibility check is pending CI.
- Quote adapter implementation remains blocked on a safe integration contract: quotes must use one coherent, fresh market snapshot; the SDK's online RPC convenience methods can perform separate reads, so they must not be allowed to silently bypass the Helius same-slot verification. Also, an aggregate SDK fee total cannot be split into the ledger's protocol/creator/pool/transfer/network categories without authoritative fee evidence. Do not create an executable paper quote until those requirements are met.


### Executable quote normalization (partial)
- Added a normalized paper quote converter for official Pump curve and PumpSwap offline SDK results.
- Converts exact SOL/WSOL base-unit amounts and SDK fee components using a fresh SOL/USD reference.
- Preserves PumpSwap LP/protocol/creator fees separately and retains the curve SDK's aggregate venue fee without fabricating a split.
- Requires explicit verified-zero transfer-tax evidence, fresh quote/price references, bounded quote TTL, explicit network/priority/provider costs and a simulated fill time before quote expiry.
- Tests cover gross/net fee reconciliation, fee-category mapping, stale references, transfer-tax fail-closed behavior and simulated-latency expiry.
- Still incomplete: non-zero Token-2022 transfer-fee calculation, live fee estimation, route/price impact slippage policy calibration, quote-to-Worker integration and end-to-end paper fills. The converter alone does not authorize entries.
