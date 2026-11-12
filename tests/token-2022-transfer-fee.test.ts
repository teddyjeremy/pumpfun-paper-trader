import {describe,expect,it} from "vitest";
import type {TransferFeeConfig} from "@solana/spl-token";
import {calculateToken2022TransferFee} from "../src/ingestion/token-2022-transfer-fee.js";

const config=(olderBps:number,newerBps:number,maxFee:bigint=10_000n):TransferFeeConfig=>({
  transferFeeConfigAuthority:null,
  withdrawWithheldAuthority:null,
  withheldAmount:0n,
  olderTransferFee:{epoch:0n,maximumFee:maxFee,transferFeeBasisPoints:olderBps},
  newerTransferFee:{epoch:10n,maximumFee:maxFee,transferFeeBasisPoints:newerBps}
});

describe("Token-2022 transfer fee calculation",()=>{
  it("selects the older schedule before its activation epoch",()=>{
    const result=calculateToken2022TransferFee({config:config(100,250),epoch:9,grossAmountBaseUnits:10_000n});
    expect(result.feeBasisPoints).toBe(100);
    expect(result.feeAmountBaseUnits).toBe("100");
    expect(result.netAmountBaseUnits).toBe("9900");
  });
  it("selects the newer schedule at its activation epoch",()=>{
    const result=calculateToken2022TransferFee({config:config(100,250),epoch:10,grossAmountBaseUnits:10_000n});
    expect(result.feeBasisPoints).toBe(250);
    expect(result.feeAmountBaseUnits).toBe("250");
    expect(result.netAmountBaseUnits).toBe("9750");
  });
  it("respects the maximum fee cap",()=>{
    const result=calculateToken2022TransferFee({config:config(5_000,5_000,200n),epoch:10,grossAmountBaseUnits:10_000n});
    expect(result.feeAmountBaseUnits).toBe("200");
    expect(result.netAmountBaseUnits).toBe("9800");
  });
  it("verifies zero-fee legacy mints without requiring an epoch",()=>{
    const result=calculateToken2022TransferFee({config:null,epoch:null,grossAmountBaseUnits:123n});
    expect(result.feeAmountBaseUnits).toBe("0");
    expect(result.netAmountBaseUnits).toBe("123");
    expect(result.verified).toBe(true);
  });
  it("fails closed when a fee mint has no verified epoch",()=>{
    expect(()=>calculateToken2022TransferFee({config:config(100,250),epoch:null,grossAmountBaseUnits:10_000n})).toThrow(/verified epoch/);
  });
  it("rejects invalid amounts and schedules",()=>{
    expect(()=>calculateToken2022TransferFee({config:null,epoch:null,grossAmountBaseUnits:0n})).toThrow();
    expect(()=>calculateToken2022TransferFee({config:config(10_001,10_001),epoch:10,grossAmountBaseUnits:10_000n})).toThrow();
  });
});
