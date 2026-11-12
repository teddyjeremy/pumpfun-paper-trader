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

The Worker now wires a deliberately smaller Helius path:
- It selects at most 10 non-migrated candidates with valid mint and bonding-curve addresses. The bounded selection is prioritized by available identity completeness (valid creator present), repeated discovery observations, then most recent activity/launch. This is only a monitoring-priority order: the discovery feed does not contain trade flow, wallet concentration, creator sells, liquidity, or executable quotes, so it cannot honestly rank trading quality yet. Missing creator data does not cause rejection; the candidate remains eligible for WATCH/monitoring, never an automatic BUY.
- Each candidate receives one standard `logsSubscribe` using a single-address `mentions` filter. No program-wide logs subscription or Enhanced WebSocket method is used.
- Only notifications with `err === null` enter the durable signature queue. Failed transactions are counted and never fetched as observations.
- The durable queue is capped at 100 signatures; signature deduplication retains the most recent 5,000 signatures. Queue overflow and malformed notifications mark the affected mint incomplete.
- The Worker drains one signature at a time through a 2 requests/second token bucket, below the Helius Free 10 RPS ceiling. The generic priority queue remains available for future open-position prioritization but is not yet used by this candidate-only worker.
- Individual transactions are fetched with standard `getTransaction`, decoded only after the successful-transaction gate, and retained with provider, commitment, slot, signature, mint and receipt timestamp. Verified retention is capped at 2,000 transactions. A fetch/processing exception marks the affected mint incomplete and removes that failed queue head so one bad signature cannot block every later candidate.
- Candidate expiry/migration removes its Helius subscription; socket reconnect clears socket-scoped subscription IDs and resubscribes the bounded active set. A persisted queue is drained after reconnection.
- Authenticated `GET /observations?limit=100` exposes up to 500 most recent verified transactions for paper analysis. BigInt event amounts/reserves are serialized as decimal strings; this endpoint does not provide quotes or trading decisions.
- Authenticated `GET /flow` groups verified trades by mint and quote mint into completed two-second event-time windows over a ten-minute horizon. It reports buy/sell quote volume, unique buyers/sellers, largest-buyer share, and the agreed three-window flow checks: each window must have a buy/sell quote-volume ratio strictly greater than 3:1, at least three unique buyers, and sellers no greater than half the buyer count; across three consecutive windows there must be at least five distinct buyers and no buyer may exceed 72% of total buy quote volume. Results are ranked by evidence completeness, flow confirmation, buyer count and concentration; raw quote volumes are not compared across different quote mints.
- A flow is marked incomplete unless it has three consecutive completed windows, is covered by an acknowledged subscription from before those windows, and has no known candidate gap. Worker restarts, socket interruptions, queue/fetch failures and unmonitored candidates are surfaced as incomplete. A successful resubscription establishes a new coverage boundary; only later windows can restore completeness. When the 2,000-transaction retention cap is reached, the earliest retained trade timestamp becomes an additional coverage boundary; recent windows can still be complete if all three windows are fully inside retained history.
- Flow confirmation is an observation/ranking feature only. It does not authorize an entry: price impulse/pullback/reclaim, wallet/creator safety, volume-profile completeness, fresh executable quotes, fee/impact limits and the paper ledger remain unimplemented gates.
The token bucket is process-local and resets on Durable Object restart; it is conservative but not a durable global quota ledger. A worker restart can therefore create a short burst up to its two-token capacity. Provider gaps, queue overflow, fetch failures and malformed messages remain explicit data gaps. This does not provide historical backfill or guarantee that every chain event is observed.

## Decoder status

- `src/ingestion/pump-events.ts` decodes Pump.fun `CreateEvent` and `TradeEvent` log payloads using the official IDL discriminators and field order.
- Amounts and reserve values remain raw integers (`bigint`); the decoder does not convert units or treat non-SOL quote amounts as SOL.
- `decodeSuccessfulPumpTransaction` gates event decoding on a successful Solana transaction (`meta.err === null`) and carries signature and slot. Failed transactions return `FAILED_TRANSACTION`; missing metadata/logs or malformed event bytes return `DATA_INCOMPLETE`.
- `src/ingestion/helius.ts` builds standard Helius HTTPS/WSS URLs, candidate-specific `logsSubscribe` requests (one bonding-curve address per subscription), parses complete `logsNotification` signatures/slots, and fetches individual transactions through standard `getTransaction` at `confirmed` by default. It checks the returned signature, successful transaction metadata, Pump.fun program invocation, and decoded event mint before returning `VERIFIED`. Provider provenance, commitment, slot, signature, and local receipt time are carried with the verified result. HTTP/RPC/network errors, unavailable transactions, and malformed metadata return `DATA_INCOMPLETE`; failed transactions and unrelated mints are not observations.
- The Helius adapter is wired to the Durable Object for bounded candidate subscriptions, a durable signature queue, conservative serial transaction fetching, and persisted verified event evidence. It remains event evidence only; no strategy decisions or quote calculations are connected.

## Not yet enabled / incomplete

- Deployed no-key PumpPortal handshake and real connection verification.
- Provider-gap reconciliation and health checks that prove subscription delivery rather than only socket-open state.
- Verified bonding-curve PDA derivation and account decoder.
- Reconnect-gap backfill and reconciliation; an open socket alone does not prove complete event delivery.
- Durable/global RPC quota accounting across Worker restarts.
- Candidate admission limits selected from measured launch volume and Cloudflare budget.
- Evidence-based trading-quality ranking. The current monitor priority deliberately uses only identity completeness, repeated discovery observations, and recency; it must not pretend these are buyer-flow, liquidity, creator-risk, or executable-exit measurements.
- Helius backfill/reconciliation for reconnect gaps.
- Full price observation windows and strict strategy evaluation. Trade-flow windows are now calculated, but are not connected to entry execution.
- Creator/linked-wallet/cluster risk evidence.
- Executable quotes, fee/impact accounting, paper execution and ledger integration.

No candidate is eligible for a paper entry until every required evidence source is complete and fresh. If capacity overflows, the counter is visible and affected candidates must remain WATCH / DATA_INCOMPLETE; no silent drop may become an entry. No reserve-delta estimate or chart price may be substituted for an executable quote.
