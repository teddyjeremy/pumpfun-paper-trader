# Roadmap

- [x] Safe paper-only project scope and invariants
- [x] Strict configuration and service health endpoints
- [x] Categorized diagnostic event registry and operator dashboard
- [ ] Verify current Pump.fun official SDK/program interfaces and implement launch decoder
- [ ] Helius stream adapter with reconnect, backfill and slot-lag measurement
- [ ] Pump.fun bonding-curve state reader and graduation detector
- [ ] Quote-only adapter with protocol, creator, network, priority, impact and slippage accounting
- [ ] Risk evidence collection and hard rejection rules
- [ ] Market windows and explainable momentum ranking
- [ ] PostgreSQL migrations and append-only event/trade ledger
- [ ] Deterministic paper executor and position state machine
- [ ] Replay harness and strategy evaluation
- [ ] Full results dashboard (positions, net PnL, costs, latency, rejected opportunities)
- [ ] Google Cloud deployment, Secret Manager, monitoring and alerts

No later stage may bypass the paper-only, bonding-curve-only, fail-closed invariants.
