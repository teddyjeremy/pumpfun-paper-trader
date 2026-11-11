# Free-tier selective ingestion

## Scope and hard constraints

The live listener remains disabled until the selective pipeline is deployed and tested. This service is paper-only: no wallet keys, signing, transaction submission, or real fills.

- PumpPortal is used only for its free `subscribeNewToken` and `subscribeMigration` discovery events. The official Data API examples show an API-key placeholder in the URL, but the same page specifically says the key and 0.02 SOL linked-wallet minimum apply to token/account subscriptions; the Fees page says the two discovery methods are uncharged. The adapter therefore uses `wss://pumpportal.fun/api/data` without a key or linked wallet. A deployed Worker connection check is still required before treating the provider as operational.
- PumpPortal states that new-token and migration events are not charged. Do not subscribe to `subscribeTokenTrade` or `subscribeAccountTrade`; these are metered at 0.01 SOL per 10,000 streamed events. Its docs attach a 0.02 SOL linked-wallet minimum to token/account subscriptions; this pipeline does not use either subscription type. Re-check the provider's current terms before enabling the connection.
- Helius Free standard Solana WebSockets and JSON-RPC are used for verification and selective monitoring. Do not use Enhanced WebSockets / `transactionSubscribe`.
- Keep Helius RPC below its 10 requests/second ceiling, with a configurable safety margin in production.
- Do not subscribe to all Pump.fun program logs. Discover launches first, then monitor only admitted candidates and open positions.
- The Cloudflare Durable Object must not receive a global firehose. Candidate caps and bounded queues are mandatory.

## Event flow

1. Consume PumpPortal new-token and migration discovery messages over one data WebSocket connection.
2. Treat every launch message as an untrusted discovery hint, not authoritative on-chain state.
3. Verify the creation transaction and mint/creator data through Helius within the RPC budget.
4. Derive the bonding-curve PDA from the official Pump program interface, then verify its owner and account data on-chain. Never trust an event-supplied curve address without verification.
5. Admit a bounded set of candidates for monitoring. Open positions have highest priority, qualified candidates next, and historical/backfill work last.
6. Use standard Helius account/log subscriptions only for admitted bonding curves. Reconcile with transaction/account reads and track provider slot lag.
7. Persist raw event references, processed signatures, observation windows, and provider health. Deduplicate by signature and instruction/event identity.
8. Feed only complete, decoded observations into the existing strict strategy. If any required observation is missing, late, malformed, dropped, or outside the freshness window, mark the candidate `DATA_INCOMPLETE` / WATCH and prohibit entry.

## Queue and budget behavior

The initial TypeScript ingestion primitives provide:
- A token bucket that rejects rates above 10 requests/second.
- A bounded RPC queue prioritizing open positions, then candidates, then backfill.
- Explicit return of rejected/evicted work so callers can persist a data-gap event.

These primitives are not a provider adapter and do not make the worker trading-ready. Production integration must persist queue overflow and missed deadlines; in-memory queue state alone is not sufficient across restarts.

## Decoder status

- `src/ingestion/pump-events.ts` now decodes Pump.fun `CreateEvent` and `TradeEvent` log payloads using the official IDL discriminators and field order.
- Amounts and reserve values remain raw integers (`bigint`); the decoder does not convert units or treat non-SOL quote amounts as SOL.
- `decodeSuccessfulPumpTransaction` now gates event decoding on a successful Solana transaction (`meta.err === null`) and carries signature and slot. Failed transactions return `FAILED_TRANSACTION`; missing metadata/logs or malformed event bytes return `DATA_INCOMPLETE`. Provider provenance and RPC commitment still need to be attached by the future adapter.
- The decoder is not yet wired into a provider adapter or observation-window builder.

## Discovery adapter status

- `src/ingestion/pumpportal.ts` provides a no-key discovery URL, an allowlist containing only `subscribeNewToken` and `subscribeMigration`, and a strict parser for `create` / `migrate` messages.
- Trade messages are ignored; no token/account trade subscription is emitted by this adapter.
- Provider receipt time is explicitly local receipt time, not a chain timestamp. Missing mint or malformed optional addresses become `DATA_INCOMPLETE`; missing creator/signature values remain null for later on-chain verification.
- The parser is a tested pure module. It is not yet connected to the Durable Object, and the deployed no-key handshake has not yet been verified.

## Not yet enabled

- PumpPortal live WebSocket connection validation in the deployed Worker, reconnect/backoff, and durable discovery-event persistence.
- Transaction-level extraction that calls the decoder only for successful Pump.fun transactions.
- Verified bonding-curve PDA derivation and account decoder.
- Candidate admission limits selected from measured launch volume and Cloudflare budget.
- Helius backfill/reconciliation for reconnect gaps.
- Durable queue, deduplication, observation windows, and provider-lag alerts.
- Quotes, risk evidence, strict entry evaluator, paper execution, and ledger integration.

No candidate is eligible for a paper entry until every required evidence source is complete and fresh. No reserve-delta estimate or chart price may be substituted for an executable quote.
