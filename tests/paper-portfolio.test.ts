import { describe, expect, it } from "vitest";
import { createPaperPortfolio, openPaperPosition, markPaperPosition, closePaperPosition, type ExecutablePaperQuote } from "../src/paper/portfolio.js";
const now = "2026-11-12T12:00:00.000Z";
function quote(mint:string,side:"BUY"|"SELL",amount="1000000",outputUsd=1):ExecutablePaperQuote {
 return {quoteId:side+mint,provider:"test-adapter",mint,side,observedAt:now,expiresAt:"2026-11-12T12:00:02.000Z",
 requestedUsd:1,inputAmountBaseUnits:side==="SELL"?amount:"1000000",outputAmountBaseUnits:side==="BUY"?amount:"1000000",outputUsd,priceImpactPct:0.5,taxPct:0.5,
 networkFeeUsd:0.001,providerFeeUsd:0.001,routeId:"verified-route",executable:true};
}
describe("paper portfolio accounting",()=>{
 it("starts with $2.70, $1 stake and one slot",()=>{
  const p=createPaperPortfolio();expect(p.availableCashUsd).toBe(2.7);
  expect(p.positionSizeUsd).toBe(1);expect(p.maxConcurrentPositions).toBe(1);
 });
 it("requires fresh exact-size quotes and refuses repeat mints",()=>{
  const p=createPaperPortfolio();
  const opened=openPaperPosition(p,{mint:"mint",positionId:"p1",occurredAt:now,buyQuote:quote("mint","BUY"),sellQuote:quote("mint","SELL"),nowMs:Date.parse(now)});
  expect(opened.state.availableCashUsd).toBe(1.698);
  expect(()=>openPaperPosition(opened.state,{mint:"mint",positionId:"p2",occurredAt:now,buyQuote:quote("mint","BUY"),sellQuote:quote("mint","SELL"),nowMs:Date.parse(now)})).toThrow(/only be bought once/);
 });
 it("rejects quotes with excessive round-trip costs",()=>{
  const p=createPaperPortfolio();const buy=quote("mint","BUY");buy.priceImpactPct=1.8;
  const sell=quote("mint","SELL");sell.priceImpactPct=1.8;
  expect(()=>openPaperPosition(p,{mint:"mint",positionId:"p1",occurredAt:now,buyQuote:buy,sellQuote:sell,nowMs:Date.parse(now)})).toThrow(/cost exceeds/);
 });
 it("marks high water and realizes net proceeds without pretending fees are profit",()=>{
  const p=createPaperPortfolio();
  const opened=openPaperPosition(p,{mint:"mint",positionId:"p1",occurredAt:now,buyQuote:quote("mint","BUY"),sellQuote:quote("mint","SELL"),nowMs:Date.parse(now)});
  const marked=markPaperPosition(opened.state,{positionId:"p1",priceUsdPerToken:0.000002,markedAt:now});
  expect(marked.positions[0]!.highWaterPriceUsdPerToken).toBe(0.000002);
  const sell=quote("mint","SELL","1000000",1.5);
  const closed=closePaperPosition(marked,{positionId:"p1",sellQuote:sell,exitReason:"TEST_EXIT",closedAt:now,nowMs:Date.parse(now)});
  expect(closed.position.status).toBe("CLOSED");
  expect(closed.position.realizedPnlUsd).toBeCloseTo(0.496);
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
  expect(state.highWaterEquityUsd).toBe(2.7);
 });
});
