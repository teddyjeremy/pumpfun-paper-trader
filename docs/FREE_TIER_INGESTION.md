# Free-tier selective ingestion

## Scope and hard constraints

The live listener remains disabled until the selective pipeline is deployed and tested. This service is paper-only: no wallet keys, signing, transaction submission, or real fills.

- PumpPortal is used only for its free `subscribeNewToken` and `subscribeMigration` discovery events. The Worker uses `wss://pumpportal.fun/api/data` without a key or linked wallet. This no-key handshake still needs to be verified in the deployed Worker before provider operation is considered confirmed.
- Do not subscribe to `subscribeTokenTrade` or `subscribeAccountTrade`; these are metered at 0.01 SOL per 10,000 streamed events. The pipeline does not use PumpPortal trading endpoints.
- Helius Free standard Solana WebSockets and JSON-RPC are reserved for verification and selective monitoring. Do not use Enhanced WebSockets / `transactionSubscribe`.
- Keep Helius RPC below its 10 requests/second ceiling, with a configurable safety margin in production.
- Do not subscribe to all Pump.fun program logs. Discover launches first, then monitor only admitted candidates and open positions.
- The Cloudflare Durable Object must not receive a global firehose. Candidate caps and bounded queues are mandatory.

## Implemented discovery path

1. The Worker connects to one PumpPortal Data API WebSocket.
2. It sends only `subscribeNewToken` and `subscribeMigration`.
3. `src/ingestion/pumpportal.ts` parses `create` and `migrate` discovery messages. Trade messages are ignored.
4. `src/ingestion/discovery-store.ts` deduplicates by mint, retains a bounded candidate set (initial cap 100), expires entries after 15 minutes, and records duplicate, migration, overflow and incomplete counts.
5. The Durable Object stores the candidate snapshot and status in one storage batch. It flushes after 25 relevant events and on the minute cron, stop, and socket close. Writes are serialized to avoid an older snapshot overwriting a newer one. Expiry is swept during cron and candidate reads, so stale candidates disappear even during quiet periods; an expiry counter is retained.
6. Authenticated `GET /candidates` returns the bounded discovery snapshot. `GET /status` reports candidate and data-gap counters.

Provider receipt time is local receipt time, not a chain timestamp. PumpPortal messages remain untrusted hints: missing creator/signature values are retained as null and must be established through chain verification. A candidate is not an entry signal.

## Queue and budget behavior

The initial TypeScript ingestion primitives provide:
- A token bucket that rejects rates above 10 requests/second.
- A bounded RPC queue prioritizing open positions, then candidates, then backfill.
- Explicit return of rejected/evicted work so callers can persist a data-gap event.

These RPC primitives are not yet wired into the Worker. The new candidate store is bounded and durable, but it is not the complete Helius work queue and does not yet schedule selective account subscriptions.

## Decoder status

- `src/ingestion/pump-events.ts` decodes Pump.fun `CreateEvent` and `TradeEvent` log payloads using the official IDL discriminators and field order.
- Amounts and reserve values remain raw integers (`bigint`); the decoder does not convert units or treat non-SOL quote amounts as SOL.
- `decodeSuccessfulPumpTransaction` gates event decoding on a successful Solana transaction (`meta.err === null`) and carries signature and slot. Failed transactions return `FAILED_TRANSACTION`; missing metadata/logs or malformed event bytes return `DATA_INCOMPLETE`.
- `src/ingestion/helius.ts` builds standard Helius HTTPS/WSS URLs, candidate-specific `logsSubscribe` requests (one bonding-curve address per subscription), parses complete `logsNotification` signatures/slots, and fetches individual transactions through standard `getTransaction` at `confirmed` by default. It checks the returned signature, successful transaction metadata, Pump.fun program invocation, and decoded event mint before returning `VERIFIED`. Provider provenance, commitment, slot, signature, and local receipt time are carried with the verified result. HTTP/RPC/network errors, unavailable transactions, and malformed metadata return `DATA_INCOMPLETE`; failed transactions and unrelated mints are not observations.
- `src/ingestion/helius-monitor.ts` adds bounded monitor-state primitives: at most 10 fresh, non-migrated candidates; one `logsSubscribe` request per bonding curve; subscription-ack mapping; successful-notification-only signature queueing; bounded 100-signature pending queue; 5,000-signature dedup history; and explicit incomplete markers for queue overflow or socket gaps. The state is serializable for Durable Object storage, but these primitives are not yet wired into the Worker's socket lifecycle or shared RPC budget.

## Not yet enabled / incomplete

- Deployed no-key PumpPortal handshake and real connection verification.
- Provider-gap reconciliation and health checks that prove subscription delivery rather than only socket-open state.
- Durable Object wiring for Helius candidate-specific subscriptions, shared rate-budget scheduling, durable state persistence, and transaction-fetch execution.
- Verified bonding-curve PDA derivation and account decoder.
- Candidate admission limits selected from measured launch volume and Cloudflare budget.
- Helius backfill/reconciliation for reconnect gaps.
- Observation windows and strict strategy evaluation.
- Creator/linked-wallet/cluster risk evidence.
- Executable quotes, fee/impact accounting, paper execution and ledger integration.

No candidate is eligible for a paper entry until every required evidence source is complete and fresh. If capacity overflows, the counter is visible and affected candidates must remain WATCH / DATA_INCOMPLETE; no silent drop may become an entry. No reserve-delta estimate or chart price may be substituted for an executable quote.
