# Paper-session recording and bankroll rules

## Bankroll policy
- Initial simulated bankroll: USD 2.70.
- If marked portfolio equity is strictly below USD 1.00, add USD 2.70.
- Exactly USD 1.00 does not trigger a top-up.
- Record every top-up immutably: sequence, timestamp, replenishment number, balance before, amount, balance after, cumulative top-ups and cumulative contributed capital.
- Never erase losses or represent a top-up as trading profit.
- Replenished capital restores cash but is excluded from portfolio-growth high-water marks, stake-tier increases and concurrent-position scaling.
- Reports must separate initial bankroll, top-up count, total top-ups, total capital contributed, current equity, realized PnL and return against contributed capital.

## Required session journal
Each session needs a unique ID, UTC start/end, strategy/config version and durable monotonic event sequence. Preserve:
1. Session start/stop, worker restarts, provider connections and heartbeats.
2. Every discovered mint, raw provider event reference, creator, curve, launch/migration times and verification.
3. Every market observation: source, slot/signature, observed/received timestamps, price, quote volume, buys/sells, unique buyers/sellers and coverage.
4. Every feature snapshot: impulse, pullback depth/duration, pullback low, reclaim, per-window buy/sell volume, buyer/seller counts, largest-buyer share and signal age.
5. Every strategy evaluation, config thresholds, per-rule PASS/FAIL/UNKNOWN, final decision and exact rejection reasons.
6. Risk evidence and coverage, including creator, linked wallets, holder concentration and unknown states.
7. Every quote request/result, age, size, route, token/SOL amounts, impact, slippage, network/protocol/creator fees and failures.
8. Every paper order, simulated fill, position update, mark, exit trigger/fill, costs and realized/unrealized PnL.
9. Every bankroll top-up and equity snapshot.
10. Every rejected/watch candidate's follow-up observations, peak price/time, multiple from rejection-time and discovery prices, 1.5x/2x/3x milestones, time-to-milestone and follow-up completeness.
11. Every dropped event, queue overflow, provider outage, reconnect, missing window, persistence failure and recovery.

## Micro-trade filtering and pullback volume
- Trades with USD notional less than or equal to $0.01 are excluded from both buy and sell flow counts, unique-wallet counts, and the price/volume buckets used for strategy evidence. Their excluded count and raw quote volume are still recorded per candidate.
- SOL quote amounts are converted from lamports using a fresh SOL/USDT last-trade reference. The Worker validates the symbol, positive price, exchange close timestamp and a maximum 10-second age; the in-memory request cache is one second.
- The reference price is only for filtering tiny trades. It is not a bonding-curve execution quote, fill price or PnL price.
- If the reference price is missing, stale or invalid, the filter is UNAVAILABLE. Flow confirmation and impulse/pullback/reclaim price-pattern passes are blocked, and pullback/reclaim buy-volume ratios remain UNKNOWN; the system does not silently count spam as valid evidence.
- Pullback volume is compared using buy-side quote volume only: pullback buys versus impulse buys, and reclaim buys versus pullback buys. Sell volume remains separately recorded for pressure analysis and the >3:1 flow rule.

## Missed-candidate outcomes
- Rejection must never delete a candidate's session history.
- Keep discovery price separate from decision-time price. A 3x from launch may still be a poor entry after a large pre-rejection run.
- Label follow-up COMPLETE, PARTIAL or MISSING. No observations means MISSING, not a loser.
- The ten Helius slots cannot guarantee continuous follow-up for every launch. Explicitly record coverage and gaps; never present incomplete outcomes as complete.
- Preserve raw observations separately from derived features and decisions for replay.

## Six-hour acceptance gate
The journal must be append-only, paginated, restart-safe, exportable and retained beyond the run. A rolling latest-N array is insufficient. Use partitioned durable pages or a database event table, idempotent event IDs and monotonic sequence numbers. Test restart during append, duplicate delivery, pagination boundaries, quota failures and export/replay.

## Implemented in the current draft PR
- Durable Object session creation/closure is atomic. Session IDs, per-session bankroll and paper portfolio are persisted. Restart markers and minute heartbeats are recorded.
- Append-only paginated event pages (100 events/page), monotonic per-session sequences and idempotency-key indexes. Event pages are retained in Durable Object storage without a session TTL.
- Discovery, verified Helius observations, selected provider connections/disconnections/reconnects, non-queued Helius notifications (including overflow, invalid signatures, unknown subscriptions, failures and duplicates), queue/data gaps, candidate expiry, holder/funding risk evidence, feature snapshots, per-rule PASS/FAIL/UNKNOWN evaluations, strategy decisions, equity marks and top-ups are journaled.
- The paper portfolio module enforces one-time mint entry, one initial concurrent position, stake scaling by 50% per portfolio doubling (capped at $100), additional slots per doubling, fresh exact-size quote evidence, per-side impact/tax limits and the 4% round-trip cost cap. Top-ups do not count as portfolio growth and cannot unlock larger stakes or more slots. It is a tested accounting primitive, not an automatically operated Worker executor.
- Candidate outcome tracking is session-scoped. It stores the discovery reserve-price baseline where available, first observed trade baseline, first strategy-decision-time price (including WATCH decisions), post-decision peak and 1.5x/2x/3x milestone timestamps. Prices are quote-mint ratios, not USD prices. Pre-rejection peaks are not counted as post-rejection performance.
- Read APIs (all control-token protected): `GET /audit/sessions`, paginated `GET /audit`, paginated JSON download `GET /audit/export`, `GET /paper-bankroll`, `GET /paper-portfolio`, `POST /paper-equity`, and `GET /candidate-outcomes`.

## Still blocked / not yet implemented
- There is no production executable quote adapter. The portfolio engine accepts verified quote evidence, but no trusted quote source supplies it.
- The Worker does not yet invoke paper entry/exit automatically. `POST /paper-equity` is a manual equity-mark endpoint; there are no connected quote/order/fill endpoints.
- Dynamic exit-window aggregation, quote-gated exits, migration-aware market transitions and realized/unrealized PnL event journaling are not connected to the Worker.
- Reclaim freshness is now evaluated from the completed 5-second reclaim bucket and subsequent verified SOL trades. It passes only when the signal is 1–2 seconds old and a later trade remains at least 1% above the previous completed high; otherwise it is FAIL or UNKNOWN. Because the underlying pattern buckets are 5 seconds, the valid freshness window is narrow and this still needs replay/backtest validation.
- Pullback-volume contraction and reclaim-volume expansion are measured but their numeric thresholds have not been agreed. Missing quote economics are always UNKNOWN, so decisions remain WATCH/REJECT and `buyAllowed=false`.
- Candidate follow-up is limited to observed verified trades on monitored candidates. Ten Helius slots do not provide complete continuous follow-up for every discovery; unobserved outcomes remain MISSING and observed-but-incomplete outcomes PARTIAL. No USD oracle is connected.
- Provider outage/reconnect/queue-overflow and persistence-failure audit coverage is improved but not exhaustive.
- Durable Object runtime tests for restart during append, duplicate delivery, pagination boundaries, storage quota failures and export/replay are still required, followed by a real six-hour soak test.

The six-hour paper session remains blocked until the missing quote source, executor/exit integration and runtime acceptance tests pass. No claim of complete market-wide follow-up coverage is made.


## Migration-aware market state (pure policy module)
- A fresh verified live curve is classified LIVE_CURVE; a complete or migrated curve is classified MIGRATION_PENDING.
- A migrated curve may have zeroed reserves. This is accepted as terminal curve evidence, but it does not authorize an exit.
- Only a fresh, verified canonical PumpSwap pool for the same mint, with non-zero base and quote reserves, advances the market state to MIGRATED_POOL_VERIFIED.
- Stale, mismatched, non-canonical or empty pool evidence moves the state to EXIT_BLOCKED. Missing fresh evidence also blocks quote requests.
- LIVE_CURVE and MIGRATED_POOL_VERIFIED only permit requesting a fresh size-specific sell quote. They do not create fills, execute sells or bypass impact, tax, fee, slippage or balance checks.
- This is currently a pure tested policy module. The authoritative on-chain account decoder, canonical pool discovery and Durable Object integration are still outstanding.

## Official Pump account decoding (current PR addition)
- Account layouts are pinned to the official `pump-fun/pump-public-docs` IDLs: Pump bonding curve discriminator `[23,183,248,55,96,216,172,96]`; PumpSwap pool discriminator `[241,154,109,4,17,177,109,188]`.
- Curve decoding checks Pump program ownership, the expected curve PDA address supplied by the official SDK derivation, discriminator, known field boundaries, mint context, slot and observation time. A completed curve is terminal/migration-pending evidence, not proof that the PumpSwap pool is already ready.
- Pool decoding checks PumpSwap program ownership, discriminator, and the current/known legacy field lengths. Pool vault balances are decoded from SPL Token / Token-2022 account data.
- Canonical pool evidence is emitted only when the caller supplies the expected canonical pool PDA, Pump pool-creator authority PDA, and pool authority PDA derived by the official SDK; pool index must be zero, the base mint and both vault addresses/mints/authorities must match, both reserves must be non-zero, and pool/vault account data must share one RPC context slot and be fresh.
- This decoder is a pure validation layer. It does not yet fetch accounts from Helius, derive PDAs itself, discover pools, compute Pump dynamic fees, produce executable quotes, or connect market state to the Worker.
- Official protocol sources: `pump-fun/pump-public-docs/idl/pump.json`, `pump_amm.json`, `docs/PUMP_PROGRAM_README.md`, `docs/PUMP_SWAP_README.md`, and `docs/FEE_PROGRAM_README.md`. The current official npm package is `@pump-fun/pump-sdk` 4.3.1. PumpSwap now ships through the `@pump-fun/pump-sdk/swap` subpath; do not add the standalone `@pump-fun/pump-swap-sdk` package. The root SDK exposes `OnlinePumpSdk`, `fetchSellState`, `fetchGlobal`, `fetchFeeConfig`, `getSellSolAmountFromTokenAmount`, v3 buy quote functions, `computeFeesBps`, `getFee` and price-impact helpers. The swap subpath exports `OnlinePumpAmmSdk`, `PumpAmmSdk`, pool types and AMM pricing methods. SDK integration and Cloudflare Worker bundle compatibility still need validation before the quote adapter can be enabled.

- Helius account reads now include bounded `getProgramAccounts` discovery for PumpSwap pools by the IDL-defined `Pool.base_mint` offset, followed by `getMultipleAccounts` snapshots for the selected pool and its two vaults. Discovery candidates remain untrusted until the pool PDA, index-zero canonical creator authority, pool authority, token-account mint/owner, non-zero effective reserves, shared context slot and freshness are verified.

## PostgreSQL migration sequencing and operator control
- Migration sequence is `0001_initial_ledger.sql`, `0002_migration_aware_positions.sql`, then `0003_dynamic_exit_observations.sql`. The former duplicate `0002` filename was removed so migration order is deterministic.
- `npm run db:migrate` applies unapplied files in lexical order, serializes concurrent runners with a PostgreSQL advisory transaction lock, and executes each migration in its own transaction. Duplicate numeric prefixes and malformed filenames are rejected before connecting.
- Migrations are **not** applied during server startup. Review and explicitly approve the target database before running the command. The Cloudflare Worker still uses its Durable Object journal; PostgreSQL trade/event writes, idempotency transitions and leader-lease integration remain incomplete.

## Dynamic exit-window observations
- Added a pure builder for complete verified 2/5/10/30-second samples. It derives buy/sell ratio, buy-volume decline, buyer-rate decline, sell-volume expansion, price response per unit of buy volume, and quote-liquidity change.
- Baselines reset across gaps, incomplete windows, quote-mint changes, venue changes and market-phase changes. Missing baselines remain null; no missing value is converted to zero.
- These observations can feed the existing dynamic exhaustion evaluator, but the builder is not connected to the Worker position loop and its thresholds still require historical replay/backtest calibration.

## Durable Object journal contract tests
- Added a mocked Durable Object storage contract harness covering concurrent append ordering, monotonic sequences, 100-event page boundaries, idempotent duplicate events, transaction rollback after simulated storage failure, restart markers and session metadata counts.
- These are deterministic storage-contract tests, not a full Miniflare/Cloudflare runtime acceptance test. Real Durable Object restart/eviction/quota tests and the six-hour soak remain outstanding.

- Paper quote accounting now requires explicit protocol, creator, pool/LP, transfer, network, priority and provider fee amounts. Gross output is stored before those costs; net sell proceeds and realized PnL subtract the complete fee breakdown. Every later exit quote is rechecked against the per-side 2% impact and 2% tax limits, and a sell quote with negative net proceeds is rejected.

- A small market verifier now connects the raw account decoders to `updatePumpMarketState`: a verified live curve becomes LIVE_CURVE, a completed curve becomes MIGRATION_PENDING, and only the fully verified canonical pool/vault snapshot advances it to MIGRATED_POOL_VERIFIED. This remains a pure adapter; Worker fetching and SDK PDA derivation are still separate integration tasks.

## Canonical PDA derivation
- Added deterministic PDA derivation using Solana `PublicKey.findProgramAddressSync` and the exact seed recipes in the official Pump IDL: `bonding-curve + mint`, `pool-authority + base_mint`, and PumpSwap `pool + index(0 as u16 LE) + creator + base_mint + quote_mint`.
- The Pump program derives the pool creator authority; the canonical pool PDA is derived under the PumpSwap program. The pool PDA itself is the token-account authority for its base/quote vaults, which the verifier now enforces.
- The market verifier derives these addresses itself from the verified curve mint/quote mint; callers can no longer supply arbitrary expected PDA values.

- The current Pump bonding-curve account layout is 166 bytes; the decoder also accepts only complete known historical field boundaries. The current PumpSwap Pool layout is 287 bytes, including the protocol-fee and creator-fee accumulators appended after the 271-byte prefix. Known older lengths are explicitly enumerated; unknown/partial lengths fail closed.

## Helius-backed market refresh pipeline
- Added `refreshPumpMarketStateFromHelius`: reads the mint-derived curve PDA using Helius `getMultipleAccounts`; a fresh incomplete curve is LIVE_CURVE and does not trigger pool discovery.
- When the curve is complete, it derives the canonical Pump pool-creator and index-0 pool PDAs, discovers candidates by `Pool.base_mint`, then re-fetches the pool and both vaults together in a single Helius RPC context slot.
- A missing pool/vault leaves the market MIGRATION_PENDING; a mismatched owner, mint, authority, PDA, stale snapshot or empty liquidity sets EXIT_BLOCKED. Only a complete verified snapshot reaches MIGRATED_POOL_VERIFIED.
- This pipeline is implemented and unit-tested, but it is not yet called by the Cloudflare Worker or connected to open paper positions, quote requests or the exit manager.
