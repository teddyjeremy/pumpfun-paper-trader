import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { Connection, PublicKey } from "@solana/web3.js";

const require = createRequire(import.meta.url);
const sdk = require("@pump-fun/pump-sdk") as {
  PumpSdk: new () => { decodeFeeConfig(account: { data: Buffer }): Record<string, unknown> };
  PUMP_FEE_CONFIG_PDA: PublicKey;
  PUMP_PROGRAM_ID: PublicKey;
  PUMP_AMM_PROGRAM_ID: PublicKey;
  PUMP_FEE_PROGRAM_ID: PublicKey;
};

function show(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof PublicKey) return value.toBase58();
  if (value && typeof value === "object" && (value as { constructor?: { name?: string } }).constructor?.name === "BN") {
    return (value as { toString(): string }).toString();
  }
  if (Array.isArray(value)) return value.map(show);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) out[key] = show(inner);
    return out;
  }
  return value;
}

async function main(): Promise<void> {
  const connection = new Connection("https://public.rpc.solanavibestation.com", "confirmed");
  const decoder = new sdk.PumpSdk();
  const ammFee = PublicKey.findProgramAddressSync(
    [Buffer.from("fee_config"), sdk.PUMP_AMM_PROGRAM_ID.toBuffer()],
    sdk.PUMP_FEE_PROGRAM_ID
  )[0];
  const accounts = [sdk.PUMP_FEE_CONFIG_PDA, ammFee];
  const decoded = [];
  for (const address of accounts) {
    const info = await connection.getAccountInfo(address);
    if (!info) throw new Error(`Missing fee config ${address.toBase58()}`);
    decoded.push({ address: address.toBase58(), fee: show(decoder.decodeFeeConfig({ data: Buffer.from(info.data) })) });
  }
  await mkdir("data", { recursive: true });
  await writeFile("data/fee-snapshot.json", `${JSON.stringify({
    capturedAt: new Date().toISOString(),
    programs: {
      pump: sdk.PUMP_PROGRAM_ID.toBase58(),
      pumpAmm: sdk.PUMP_AMM_PROGRAM_ID.toBase58()
    },
    decoded
  }, null, 2)}\n`);
  console.log("wrote data/fee-snapshot.json");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
