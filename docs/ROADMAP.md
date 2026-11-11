# Roadmap

- [x] Paper-only scope and original strict entry strategy specification
- [x] Migration-aware, no-time-cap exit specification
- [x] Strict configuration and service health endpoints
- [x] Categorized diagnostic event registry and operator dashboard
- [x] Pure migration-aware exit policy and unit tests
- [x] Portfolio doubling/stake policy and unit tests
- [x] Position schema extension for migration handoff and exit observations
- [ ] Verify current Pump.fun official SDK/program interfaces and implement launch decoder
- [ ] Helius stream adapter with reconnect, backfill and slot-lag measurement
- [ ] Pump.fun bonding-curve state reader and authoritative graduation detector
- [ ] Canonical PumpSwap pool discovery and venue-specific quote adapter
- [ ] Quote-only adapter with protocol, creator, network, priority, impact and slippage accounting
- [ ] Original strategy risk evidence collection and hard rejection rules
- [ ] Original entry windows and explainable momentum decision engine
- [ ] PostgreSQL migration runner and append-only event/quote/trade writer
- [ ] Deterministic paper executor and restart-safe position state machine
- [ ] Dynamic exit signal integration with live market windows and persisted protective stops
- [ ] Portfolio policy integration with live equity and open-slot reservation
- [ ] Replay harness and strategy evaluation
- [ ] Durable, authenticated read-only dashboard API
- [ ] Google Cloud resources, Secret Manager, IAM, monitoring and deployment verification

No later stage may bypass paper-only mode, original entry rules, migration-aware exits or fail-closed quote/risk invariants.
