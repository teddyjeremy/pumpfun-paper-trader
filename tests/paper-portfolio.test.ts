import { describe, expect, it } from "vitest";
import { createPaperPortfolio, openPaperPosition, markPaperPosition, closePaperPosition, type ExecutablePaperQuote } from "../src/paper/portfolio.js";
const now = "2026-11-12T12:00:00.000Z";
function quote(mint:string,side:"BUY"|"SELL",amount="1000000",outputUsd?:number):ExecutablePaperQuote {
 const grossOutputUsd=outputUsd??(side==="SELL"?1.02:1);
 const venue = "PUMP_CURVE" as const;
 const quoteMint = "So11111111111111111111111111111111111111112";
 const slot = side === "BUY" ? 100 : 101;
 const inputAmountBaseUnits = side === "SELL" ? amount : "1000000";
 const quoteId = ["pump-sdk-4.3.1",venue,side,mint,slot,inputAmountBaseUnits,now].join(":");
 return {quoteId,provider:"pump-sdk-4.3.1",mint,side,venue,quoteMint,slot,observedAt:now,expiresAt:"2026-11-12T12:00:02.000Z",
 requestedUsd:1,inputAmountBaseUnits,outputAmountBaseUnits:side==="BUY"?amount:"1000000",tokenDecimals:6,outputUsd:grossOutputUsd,priceImpactPct:0.5,taxPct:0,
 networkFeeUsd:0.001,priorityFeeUsd:0.001,providerFeeUsd:0.001,protocolFeeUsd:0.002,creatorFeeUsd:0.001,poolFeeUsd:0.001,transferFeeUsd:0,routeId:`${venue}:${quoteMint}:${slot}`,executable:true};
}
describe("paper portfolio accounting",()=>{
 it("starts with $2.70, $1 stake and one slot",()=>{
  const p=createPaperPortfolio();expect(p.availableCashUsd).toBe(2.7);
  expect(p.positionSizeUsd).toBe(1);expect(p.maxConcurrentPositions).toBe(1);
 });
 it("accepts only sub-micro-dollar SOL lamport rounding around the configured stake",()=>{
  const p=createPaperPortfolio();
  const buy=quote("rounded-stake","BUY");
  buy.requestedUsd=1.0000005;
  const opened=openPaperPosition(p,{mint:"rounded-stake",positionId:"rounded-position",occurredAt:now,
    buyQuote:buy,sellQuote:quote("rounded-stake","SELL"),nowMs:Date.parse(now)});
  expect(opened.position.stakeUsd).toBe(1);
  const tooLarge=quote("rounded-stake-large","BUY");
  tooLarge.requestedUsd=1.000002;
  expect(()=>openPaperPosition(p,{mint:"rounded-stake-large",positionId:"rounded-position-large",occurredAt:now,
    buyQuote:tooLarge,sellQuote:quote("rounded-stake-large","SELL"),nowMs:Date.parse(now)})).toThrow(/exact planned stake/);
 });
 it("rejects initial sellability quotes with an older slot or observation time",()=>{
  for (const older of [
   {slot:99,observedAt:now},
   {slot:101,observedAt:"2026-11-12T11:59:59.900Z"}
  ]) {
   const p=createPaperPortfolio();
   const buy=quote("old-sell","BUY");
   const sell=quote("old-sell","SELL");
   sell.slot=older.slot;
   sell.observedAt=older.observedAt;
   sell.quoteId=["pump-sdk-4.3.1",sell.venue,sell.side,sell.mint,sell.slot,sell.inputAmountBaseUnits,sell.observedAt].join(":");
   sell.routeId=`${sell.venue}:${sell.quoteMint}:${sell.slot}`;
   expect(()=>openPaperPosition(p,{mint:"old-sell",positionId:"old-sell-position",occurredAt:now,
     buyQuote:buy,sellQuote:sell,nowMs:Date.parse(now)})).toThrow(/later or same-slot observation/);
  }
 });
 it("rejects initial sellability quotes from a different venue or SOL quote mint",()=>{
  for (const change of [{venue:"PUMPSWAP"},{quoteMint:"11111111111111111111111111111111"}]) {
   const p=createPaperPortfolio();
   const buy=quote("different-market","BUY");
   const sell=quote("different-market","SELL");
   Object.assign(sell,change);
   sell.quoteId=["pump-sdk-4.3.1",sell.venue,sell.side,sell.mint,sell.slot,sell.inputAmountBaseUnits,sell.observedAt].join(":");
   sell.routeId=`${sell.venue}:${sell.quoteMint}:${sell.slot}`;
   expect(()=>openPaperPosition(p,{mint:"different-market",positionId:"different-market-position",occurredAt:now,
     buyQuote:buy,sellQuote:sell,nowMs:Date.parse(now)})).toThrow(/same venue and quote mint/);
  }
 });
 it("rejects non-SOL quote mints at the portfolio boundary",()=>{
  const p=createPaperPortfolio();
  const buy=quote("unsupported-quote-mint","BUY");
  buy.quoteMint="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  buy.routeId=`${buy.venue}:${buy.quoteMint}:${buy.slot}`;
  expect(()=>openPaperPosition(p,{mint:"unsupported-quote-mint",positionId:"unsupported-quote-mint-position",occurredAt:now,
    buyQuote:buy,sellQuote:quote("unsupported-quote-mint","SELL"),nowMs:Date.parse(now)}))
    .toThrow(/official Pump SDK market snapshot/);
 });
 it("rejects nonzero transfer tax or transfer fees even when the generic tax limit would allow them",()=>{
  const p=createPaperPortfolio();
  const taxed=quote("taxed-token","BUY");
  taxed.taxPct=0.1;
  expect(()=>openPaperPosition(p,{mint:"taxed-token",positionId:"taxed-token-position",occurredAt:now,
    buyQuote:taxed,sellQuote:quote("taxed-token","SELL"),nowMs:Date.parse(now)}))
    .toThrow(/unsupported non-zero transfer tax\/fee/);
  const transferFee=quote("transfer-fee-token","BUY");
  transferFee.transferFeeUsd=0.001;
  expect(()=>openPaperPosition(p,{mint:"transfer-fee-token",positionId:"transfer-fee-position",occurredAt:now,
    buyQuote:transferFee,sellQuote:quote("transfer-fee-token","SELL"),nowMs:Date.parse(now)}))
    .toThrow(/unsupported non-zero transfer tax\/fee/);
 });
 it("rejects quote metadata that is not bound to the official SDK identity",()=>{
  const p=createPaperPortfolio();
  const buy=quote("forged-provider","BUY");
  Object.assign(buy,{provider:"test-adapter"});
  expect(()=>openPaperPosition(p,{mint:"forged-provider",positionId:"forged-provider-position",occurredAt:now,
    buyQuote:buy,sellQuote:quote("forged-provider","SELL"),nowMs:Date.parse(now)}))
    .toThrow(/official Pump SDK market snapshot/);
 });

 it("rejects non-boolean executable quote flags at the atomic portfolio boundary",()=>{
  for (const side of ["BUY","SELL"] as const) {
   const p=createPaperPortfolio();
   const buy=quote("malformed-executable","BUY");
   const sell=quote("malformed-executable","SELL");
   Object.assign(side === "BUY" ? buy : sell,{executable:"false"});
   expect(()=>openPaperPosition(p,{mint:"malformed-executable",positionId:`malformed-${side.toLowerCase()}`,occurredAt:now,
     buyQuote:buy,sellQuote:sell,nowMs:Date.parse(now)})).toThrow(/Executable quote identity or status is invalid/);
  }
 });
 it("requires fresh exact-size quotes and refuses repeat mints",()=>{
  const p=createPaperPortfolio();
  const opened=openPaperPosition(p,{mint:"mint",positionId:"p1",occurredAt:now,buyQuote:quote("mint","BUY"),sellQuote:quote("mint","SELL"),nowMs:Date.parse(now)});
  expect(opened.state.availableCashUsd).toBe(1.686);
  expect(()=>openPaperPosition(opened.state,{mint:"mint",positionId:"p2",occurredAt:now,buyQuote:quote("mint","BUY"),sellQuote:quote("mint","SELL"),nowMs:Date.parse(now)})).toThrow(/only be bought once/);
 });
 it("fails closed when a closed position is missing from enteredMints",()=>{
  const opened=openPaperPosition(createPaperPortfolio(),{mint:"history-mint",positionId:"history-position",occurredAt:now,
   buyQuote:quote("history-mint","BUY"),sellQuote:quote("history-mint","SELL"),nowMs:Date.parse(now)});
  const closed=closePaperPosition(opened.state,{positionId:"history-position",sellQuote:quote("history-mint","SELL","1000000",1.5),
   exitReason:"TEST_EXIT",closedAt:now,nowMs:Date.parse(now)});
  const corrupted={...closed.state,enteredMints:[]};
  expect(()=>openPaperPosition(corrupted,{mint:"history-mint",positionId:"reentered-position",occurredAt:now,
   buyQuote:quote("history-mint","BUY"),sellQuote:quote("history-mint","SELL"),nowMs:Date.parse(now)}))
   .toThrow(/mint history is incomplete/);
 });
 it("fails closed when persisted closed-position history contains a duplicate mint row",()=>{
  const opened=openPaperPosition(createPaperPortfolio(),{mint:"history-mint",positionId:"history-position",occurredAt:now,
   buyQuote:quote("history-mint","BUY"),sellQuote:quote("history-mint","SELL"),nowMs:Date.parse(now)});
  const closed=closePaperPosition(opened.state,{positionId:"history-position",sellQuote:quote("history-mint","SELL","1000000",1.5),
   exitReason:"TEST_EXIT",closedAt:now,nowMs:Date.parse(now)});
  const corrupted={...closed.state,positions:[...closed.state.positions,{...closed.position,positionId:"duplicate-history-position"}]};
  expect(()=>openPaperPosition(corrupted,{mint:"new-mint",positionId:"new-position",occurredAt:now,
   buyQuote:quote("new-mint","BUY"),sellQuote:quote("new-mint","SELL"),nowMs:Date.parse(now)}))
   .toThrow(/duplicate mint/);
 });
 it("fails closed when the persisted entered-mint index contains duplicates",()=>{
  const corrupted={...createPaperPortfolio(),enteredMints:["repeat-mint","repeat-mint"]};
  expect(()=>openPaperPosition(corrupted,{mint:"new-mint",positionId:"new-position",occurredAt:now,
   buyQuote:quote("new-mint","BUY"),sellQuote:quote("new-mint","SELL"),nowMs:Date.parse(now)}))
   .toThrow(/entered-mint history is malformed or duplicated/);
 });
 it("locks refundable ATA rent separately from trade costs and releases it on close",()=>{
  const p=createPaperPortfolio();
  const opened=openPaperPosition(p,{mint:"rent-mint",positionId:"rent-position",occurredAt:now,
    buyQuote:quote("rent-mint","BUY"),sellQuote:quote("rent-mint","SELL"),rentReserveUsd:0.2,nowMs:Date.parse(now)});
  expect(opened.state.availableCashUsd).toBeCloseTo(1.486,8);
  expect(opened.state.reservedAccountRentUsd).toBeCloseTo(0.2,8);
  expect(opened.position.rentReserveUsd).toBeCloseTo(0.2,8);
  const closed=closePaperPosition(opened.state,{positionId:"rent-position",sellQuote:quote("rent-mint","SELL","1000000",1.5),
    exitReason:"TEST_EXIT",closedAt:now,nowMs:Date.parse(now)});
  expect(closed.state.reservedAccountRentUsd).toBe(0);
  expect(closed.state.availableCashUsd).toBeCloseTo(3.186,8);
  expect(closed.position.rentReserveUsd).toBeCloseTo(0.2,8);
 });

 it("locks the expected sell fee and only permits concurrent entries after a verified equity doubling",()=>{
  const state=createPaperPortfolio(6);
  const first=openPaperPosition(state,{mint:"reserved-fee-1",positionId:"reserved-fee-position-1",occurredAt:now,
    buyQuote:quote("reserved-fee-1","BUY"),sellQuote:quote("reserved-fee-1","SELL"),nowMs:Date.parse(now)});
  expect(first.position.expectedSellCostsUsd).toBeCloseTo(0.007,8);
  expect(first.state.availableCashUsd).toBeCloseTo(4.986,8);
  expect(first.state.maxConcurrentPositions).toBe(1);

  // A fresh full-position SDK sell quote marks the $6 initial portfolio at
  // exactly $12. Only that verified 2x equity mark unlocks the second slot
  // and the 50% stake increase; a test-only capacity override would bypass
  // the production scaling invariant.
  const doubled=markPaperPosition(first.state,{sellQuotes:[
    quote("reserved-fee-1","SELL","1000000",7.014)
  ],markedAt:now,nowMs:Date.parse(now)});
  expect(doubled.highWaterEquityUsd).toBeCloseTo(12,8);
  expect(doubled.maxConcurrentPositions).toBe(2);
  expect(doubled.positionSizeUsd).toBe(1.5);

  const secondBuy=quote("reserved-fee-2","BUY");
  secondBuy.requestedUsd=doubled.positionSizeUsd;
  const second=openPaperPosition(doubled,{mint:"reserved-fee-2",positionId:"reserved-fee-position-2",occurredAt:now,
    buyQuote:secondBuy,sellQuote:quote("reserved-fee-2","SELL"),nowMs:Date.parse(now)});
  expect(second.state.availableCashUsd).toBeCloseTo(3.472,8);
  const closed=closePaperPosition(second.state,{positionId:"reserved-fee-position-1",
    sellQuote:quote("reserved-fee-1","SELL","1000000",1.5),exitReason:"TEST_EXIT",closedAt:now,nowMs:Date.parse(now)});
  expect(closed.state.availableCashUsd).toBeCloseTo(4.972,8);
 });
 
 it("requires cash to cover the expected sell fee before an entry",()=>{
  const p={...createPaperPortfolio(),availableCashUsd:1.01};
  expect(()=>openPaperPosition(p,{mint:"sell-fee-budget",positionId:"sell-fee-position",occurredAt:now,
    buyQuote:quote("sell-fee-budget","BUY"),sellQuote:quote("sell-fee-budget","SELL"),nowMs:Date.parse(now)}))
    .toThrow(/stake, buy and sell fees, and refundable account rent reserve/);
 });
 
 it("blocks an entry when stake, fees and refundable rent cannot all be reserved",()=>{
  const p=createPaperPortfolio();
  expect(()=>openPaperPosition(p,{mint:"rent-mint",positionId:"rent-position",occurredAt:now,
    buyQuote:quote("rent-mint","BUY"),sellQuote:quote("rent-mint","SELL"),rentReserveUsd:2,nowMs:Date.parse(now)}))
    .toThrow(/stake and refundable account rent reserve/);
 });

 it("rejects quotes with missing or non-finite notional evidence",()=>{
  const p=createPaperPortfolio();
  const buy=quote("mint","BUY"); buy.requestedUsd=Number.NaN;
  expect(()=>openPaperPosition(p,{mint:"mint",positionId:"p1",occurredAt:now,buyQuote:buy,sellQuote:quote("mint","SELL"),nowMs:Date.parse(now)})).toThrow(/invalid amount or cost evidence/);
 });
 it("rejects malformed exit timestamps and empty exit reasons",()=>{
  const p=createPaperPortfolio();
  const opened=openPaperPosition(p,{mint:"mint",positionId:"p1",occurredAt:now,buyQuote:quote("mint","BUY"),sellQuote:quote("mint","SELL"),nowMs:Date.parse(now)});
  expect(()=>closePaperPosition(opened.state,{positionId:"p1",sellQuote:quote("mint","SELL"),exitReason:" ",closedAt:now,nowMs:Date.parse(now)})).toThrow(/timestamp and reason/);
  expect(()=>closePaperPosition(opened.state,{positionId:"p1",sellQuote:quote("mint","SELL"),exitReason:"STOP",closedAt:"invalid",nowMs:Date.parse(now)})).toThrow(/timestamp and reason/);
 });
 it("rejects quotes with excessive round-trip costs",()=>{
  const p=createPaperPortfolio();const buy=quote("mint","BUY");buy.priceImpactPct=1.8;
  const sell=quote("mint","SELL");sell.priceImpactPct=1.8;
  expect(()=>openPaperPosition(p,{mint:"mint",positionId:"p1",occurredAt:now,buyQuote:buy,sellQuote:sell,nowMs:Date.parse(now)})).toThrow(/cost exceeds/);
 });
 it("marks high water and realizes net proceeds without pretending fees are profit",()=>{
  const p=createPaperPortfolio();
  const opened=openPaperPosition(p,{mint:"mint",positionId:"p1",occurredAt:now,buyQuote:quote("mint","BUY"),sellQuote:quote("mint","SELL"),nowMs:Date.parse(now)});
  const marked=markPaperPosition(opened.state,{sellQuotes:[quote("mint","SELL","1000000",2.007)],markedAt:now,nowMs:Date.parse(now)});
  expect(marked.positions[0]!.highWaterPriceUsdPerToken).toBeCloseTo(2);
  expect(marked.positions[0]!.latestLiquidationValueUsd).toBeCloseTo(2);
  const sell=quote("mint","SELL","1000000",1.5);
  const closed=closePaperPosition(marked,{positionId:"p1",sellQuote:sell,exitReason:"TEST_EXIT",closedAt:now,nowMs:Date.parse(now)});
  expect(closed.position.status).toBe("CLOSED");
  expect(closed.position.realizedPnlUsd).toBeCloseTo(0.486);
 });
 it("records an automatic top-up only after cumulative losses take equity below $1",()=>{
  let state=createPaperPortfolio();
  for (let i=1;i<=3;i++) {
   const mint="mint"+i;
   const opened=openPaperPosition(state,{mint,positionId:"p"+i,occurredAt:now,buyQuote:quote(mint,"BUY"),sellQuote:quote(mint,"SELL"),nowMs:Date.parse(now)});
   const lossQuote=quote(mint,"SELL","1000000",0.25);
   const closed=closePaperPosition(opened.state,{positionId:"p"+i,sellQuote:lossQuote,exitReason:"STOP",closedAt:now,nowMs:Date.parse(now)});
   state=closed.state;
  }
  expect(state.bankroll.topUpCount).toBe(1);
  expect(state.bankroll.totalTopUpsUsd).toBe(2.7);
  expect(state.positionSizeUsd).toBe(1);
  expect(state.maxConcurrentPositions).toBe(1);
  expect(state.highWaterEquityUsd).toBe(2.706);
 });

 it("includes aggregate Pump SDK fees in entry cost and liquidation proceeds",()=>{
  const p=createPaperPortfolio();
  const buy=quote("mint-aggregate","BUY");buy.pumpFeeUsd=0.005;
  const sell=quote("mint-aggregate","SELL");sell.pumpFeeUsd=0.005;
  const opened=openPaperPosition(p,{mint:"mint-aggregate",positionId:"p-aggregate",occurredAt:now,buyQuote:buy,sellQuote:sell,nowMs:Date.parse(now)});
  expect(opened.position.buyCostsUsd).toBeCloseTo(0.009,8);
  expect(opened.position.latestLiquidationValueUsd).toBeCloseTo(1.011,8);
  expect(opened.state.availableCashUsd).toBeCloseTo(1.682,8);
 });

 it("includes protocol, creator, pool, priority and transfer fees in the round-trip cap",()=>{
  const p=createPaperPortfolio();
  const buy=quote("mint","BUY");buy.protocolFeeUsd=0.03;
  const sell=quote("mint","SELL");sell.creatorFeeUsd=0.03;
  expect(()=>openPaperPosition(p,{mint:"mint",positionId:"p1",occurredAt:now,buyQuote:buy,sellQuote:sell,nowMs:Date.parse(now)})).toThrow(/cost exceeds/);
 });
 it("refuses an exit quote whose gross proceeds cannot cover its full fee breakdown",()=>{
  const p=createPaperPortfolio();
  const opened=openPaperPosition(p,{mint:"mint",positionId:"p1",occurredAt:now,buyQuote:quote("mint","BUY"),sellQuote:quote("mint","SELL"),nowMs:Date.parse(now)});
  const sell=quote("mint","SELL","1000000",0.005);sell.protocolFeeUsd=0.01;
  expect(()=>closePaperPosition(opened.state,{positionId:"p1",sellQuote:sell,exitReason:"TEST",closedAt:now,nowMs:Date.parse(now)}))
    .toThrow(/negative net proceeds/);
 });


 it("rechecks impact and tax limits on later exit quotes",()=>{
  const p=createPaperPortfolio();
  const opened=openPaperPosition(p,{mint:"mint",positionId:"p1",occurredAt:now,buyQuote:quote("mint","BUY"),sellQuote:quote("mint","SELL"),nowMs:Date.parse(now)});
  const sell=quote("mint","SELL");sell.priceImpactPct=2.1;
  expect(()=>closePaperPosition(opened.state,{positionId:"p1",sellQuote:sell,exitReason:"TEST",closedAt:now,nowMs:Date.parse(now)}))
    .toThrow(/per-side impact or tax limit/);
 });

 it("fails closed when the quote validation clock is invalid",()=>{
  const p=createPaperPortfolio();
  expect(()=>openPaperPosition(p,{mint:"mint",positionId:"p1",occurredAt:now,buyQuote:quote("mint","BUY"),sellQuote:quote("mint","SELL"),nowMs:Number.NaN})).toThrow(/clock is invalid/);
 });

 it("rejects invalid token decimal counts instead of mispricing base units",()=>{
  const p=createPaperPortfolio();
  const buy=quote("mint","BUY");buy.tokenDecimals=19;
  expect(()=>openPaperPosition(p,{mint:"mint",positionId:"p1",occurredAt:now,buyQuote:buy,sellQuote:quote("mint","SELL"),nowMs:Date.parse(now)})).toThrow(/invalid amount or cost evidence/);
 });

 it("uses net liquidation value after sell fees for initial equity",()=>{
  const opened=openPaperPosition(createPaperPortfolio(),{mint:"mint",positionId:"p1",occurredAt:now,buyQuote:quote("mint","BUY"),sellQuote:quote("mint","SELL"),nowMs:Date.parse(now)});
  expect(opened.position.latestLiquidationValueUsd).toBeCloseTo(1.013);
  expect(opened.state.bankroll.currentEquityUsd).toBeCloseTo(2.706);
 });
 it("requires one exact-size sell quote for every open position before marking equity",()=>{
  let state=createPaperPortfolio();
  state={...state,maxConcurrentPositions:2};
  const first=openPaperPosition(state,{mint:"mint1",positionId:"p1",occurredAt:now,buyQuote:quote("mint1","BUY"),sellQuote:quote("mint1","SELL"),nowMs:Date.parse(now)});
  const unlocked={...first.state,maxConcurrentPositions:2};
  const second=openPaperPosition(unlocked,{mint:"mint2",positionId:"p2",occurredAt:now,buyQuote:quote("mint2","BUY"),sellQuote:quote("mint2","SELL"),nowMs:Date.parse(now)});
  expect(()=>markPaperPosition(second.state,{sellQuotes:[quote("mint1","SELL")],markedAt:now,nowMs:Date.parse(now)})).toThrow(/every open position/);
 });
 it("values each concurrent position from its own sell quote rather than reusing one quote",()=>{
  let state=createPaperPortfolio();
  state={...state,maxConcurrentPositions:2};
  const first=openPaperPosition(state,{mint:"mint1",positionId:"p1",occurredAt:now,buyQuote:quote("mint1","BUY"),sellQuote:quote("mint1","SELL"),nowMs:Date.parse(now)});
  const unlocked={...first.state,maxConcurrentPositions:2};
  const second=openPaperPosition(unlocked,{mint:"mint2",positionId:"p2",occurredAt:now,buyQuote:quote("mint2","BUY"),sellQuote:quote("mint2","SELL"),nowMs:Date.parse(now)});
  const marked=markPaperPosition(second.state,{sellQuotes:[
    quote("mint1","SELL","1000000",1.007),
    quote("mint2","SELL","1000000",2.007)
  ],markedAt:now,nowMs:Date.parse(now)});
  expect(marked.positions.find(p=>p.mint==="mint1")!.latestLiquidationValueUsd).toBeCloseTo(1);
  expect(marked.positions.find(p=>p.mint==="mint2")!.latestLiquidationValueUsd).toBeCloseTo(2);
  expect(marked.bankroll.currentEquityUsd).toBeCloseTo(3.686);
 });

 it("rejects duplicate position IDs",()=>{
  const opened=openPaperPosition(createPaperPortfolio(),{mint:"mint",positionId:"p1",occurredAt:now,buyQuote:quote("mint","BUY"),sellQuote:quote("mint","SELL"),nowMs:Date.parse(now)});
  expect(()=>openPaperPosition(opened.state,{mint:"mint2",positionId:"p1",occurredAt:now,buyQuote:quote("mint2","BUY"),sellQuote:quote("mint2","SELL"),nowMs:Date.parse(now)})).toThrow(/position ID must be unique/);
 });
 it("adds one slot and compounds stake by 50% only at exact equity doublings, capped at $100",()=>{
  const openAndMark=(value:number)=>{
   const opened=openPaperPosition(createPaperPortfolio(),{mint:"mint",positionId:"p1",occurredAt:now,buyQuote:quote("mint","BUY"),sellQuote:quote("mint","SELL"),nowMs:Date.parse(now)});
   return markPaperPosition(opened.state,{sellQuotes:[quote("mint","SELL","1000000",value+0.007)],markedAt:now,nowMs:Date.parse(now)});
  };
  // Default initial bankroll is $2.70, so the first growth level is $5.40.
  const belowDouble=openAndMark(3.706);
  expect(belowDouble.bankroll.currentEquityUsd).toBeCloseTo(5.399);
  expect(belowDouble.maxConcurrentPositions).toBe(1);
  expect(belowDouble.positionSizeUsd).toBe(1);
  const atFirstDouble=openAndMark(3.707);
  expect(atFirstDouble.bankroll.currentEquityUsd).toBeCloseTo(5.4);
  expect(atFirstDouble.maxConcurrentPositions).toBe(2);
  expect(atFirstDouble.positionSizeUsd).toBe(1.5);
  const atSecondDouble=openAndMark(9.107);
  expect(atSecondDouble.bankroll.currentEquityUsd).toBeCloseTo(10.8);
  expect(atSecondDouble.maxConcurrentPositions).toBe(3);
  expect(atSecondDouble.positionSizeUsd).toBe(2.25);
  const atThirdDouble=openAndMark(19.907);
  expect(atThirdDouble.bankroll.currentEquityUsd).toBeCloseTo(21.6);
  expect(atThirdDouble.maxConcurrentPositions).toBe(4);
  expect(atThirdDouble.positionSizeUsd).toBe(3.375);
  const atFourthDouble=openAndMark(41.507);
  expect(atFourthDouble.bankroll.currentEquityUsd).toBeCloseTo(43.2);
  expect(atFourthDouble.maxConcurrentPositions).toBe(5);
  expect(atFourthDouble.positionSizeUsd).toBe(5.0625);
  const atStakeCap=openAndMark(11_057.507);
  expect(atStakeCap.bankroll.currentEquityUsd).toBeCloseTo(11_059.2);
  expect(atStakeCap.maxConcurrentPositions).toBe(13);
  expect(atStakeCap.positionSizeUsd).toBe(100);
 });

});
