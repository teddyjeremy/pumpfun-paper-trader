# External technical references

Verified during initial implementation planning (2026-11-04):

- Official Pump TypeScript SDK package: https://www.npmjs.com/package/@pump-fun/pump-sdk
- Pump developer docs: https://docs.pump.fun/
- Pump bonding curve behavior and graduation: https://pump.fun/docs/bonding-curve
- Helius LaserStream SDK: https://github.com/helius-labs/laserstream-sdk
- Helius SDK: https://github.com/helius-labs/helius-sdk

## Integration decisions

- Use the official `@pump-fun/pump-sdk` root package for bonding-curve account decoding and quote math. Do not import the SDK's PumpSwap subpath in this project.
- Begin with Helius standard Solana RPC/WebSocket for affordability and operational simplicity. Benchmark stream lag and reconnect behavior. LaserStream is an optional later upgrade; verify plan pricing/limits before enabling.
- Do not treat the Pump developer REST API as a replacement for on-chain curve state or transaction stream data.
- Pump fees are dynamic and must be derived from current on-chain fee configuration / official SDK quote calculations. Do not hardcode a universal flat fee percentage.
- Keep Pump API and Helius credentials server-side only, in environment secrets locally and Google Secret Manager in production.
