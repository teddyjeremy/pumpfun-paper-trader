# Roadmap

- [x] Safe paper-only project scope and invariants
- [x] Strict configuration and service health endpoints
- [x] Categorized diagnostic event registry and operator dashboard
- [x] Migration-aware pure exit-policy module and unit tests
- [x] Position schema extension for PumpSwap handoff and exit observations
- [x] Docker and Cloud Build deployment scaffold
- [ ] Verify current Pump.fun official SDK/program interfaces and implement launch decoder
- [ ] Helius stream adapter with reconnect, backfill and slot-lag measurement
- [ ] Pump.fun bonding-curve state reader and graduation detector
- [ ] Canonical PumpSwap pool discovery and venue-specific quote adapter
- [ ] Quote-only adapter with protocol, creator, network, priority, impact and slippage accounting
- [ ] Risk evidence collection and original strategy hard rejection rules
- [ ] Original entry windows and explainable momentum decision engine
- [ ] PostgreSQL migration runner and append-only event/trade writer
- [ ] Deterministic paper executor and restart-safe position state machine
- [ ] Dynamic sell signal integration with live market windows and stop persistence
- [ ] Portfolio doubling position/stake sizing schedule
- [ ] Replay harness and strategy evaluation
- [ ] Dashboard backed by durable, authenticated read-only API
- [ ] Google Cloud resources, Secret Manager, IAM, monitoring and deployment verification

No later stage may bypass the paper-only, original-entry, migration-aware-exit and fail-closed invariants.
