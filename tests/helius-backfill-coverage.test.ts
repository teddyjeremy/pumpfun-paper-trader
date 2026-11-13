import {describe,expect,it} from "vitest";
import {assessHistoricalDecodeCoverage} from "../src/ingestion/helius-backfill-coverage.js";
import type {HistoricalBackfillState} from "../src/ingestion/helius-backfill.js";

const signatures=[{signature:"sig-a",slot:1,blockTime:100,err:null},{signature:"sig-b",slot:2,blockTime:101,err:null},{signature:"sig-c",slot:3,blockTime:102,err:null}];
const state={status:"COMPLETE",signatures} as HistoricalBackfillState;
const base={
 state,queueCursor:3,queueSignatures:[],verifiedSignatures:["sig-a","sig-b"],
 failedSignatures:["sig-c"],archivedSignatures:["sig-a","sig-b"],incompleteReason:null
};
describe("historical transaction decode coverage",()=>{
 it("requires every signature to have a terminal verified or failed outcome",()=>{
  expect(assessHistoricalDecodeCoverage(base).complete).toBe(true);
  expect(assessHistoricalDecodeCoverage({...base,verifiedSignatures:["sig-a"],failedSignatures:[]}).complete).toBe(false);
 });
 it("requires all verified transactions to be durably archived",()=>{
  const result=assessHistoricalDecodeCoverage({...base,archivedSignatures:["sig-a"]});
  expect(result.complete).toBe(false);
  expect(result.reason).toContain("unarchived");
 });
 it("does not complete while queue work remains",()=>{
  const result=assessHistoricalDecodeCoverage({...base,failedSignatures:[],archivedSignatures:["sig-a","sig-b"],queueSignatures:["sig-c"]});
  expect(result.complete).toBe(false);
  expect(result.reason).toContain("transaction queue");
 });
 it("does not complete after retry exhaustion or incomplete decoding",()=>{
  const result=assessHistoricalDecodeCoverage({...base,incompleteReason:"retry exhausted"});
  expect(result.complete).toBe(false);
  expect(result.reason).toBe("retry exhausted");
 });
 it("does not complete before every signature is queued",()=>{
  const result=assessHistoricalDecodeCoverage({...base,queueCursor:2});
  expect(result.complete).toBe(false);
 });
 it("rejects duplicate or unrelated signature evidence",()=>{
  expect(()=>assessHistoricalDecodeCoverage({...base,verifiedSignatures:["sig-a","sig-a"]})).toThrow();
  expect(()=>assessHistoricalDecodeCoverage({...base,archivedSignatures:["sig-a","other"]})).toThrow();
 });
 it("rejects a signature marked both verified and failed",()=>{
  expect(()=>assessHistoricalDecodeCoverage({...base,failedSignatures:["sig-a","sig-c"]})).toThrow();
 });
 it("rejects unrelated queue entries instead of silently filtering them",()=>{
  expect(()=>assessHistoricalDecodeCoverage({...base,queueSignatures:["other"]})).toThrow();
 });
 it("rejects archived signatures that were never successfully decoded",()=>{
  expect(()=>assessHistoricalDecodeCoverage({...base,archivedSignatures:["sig-a","sig-c"]})).toThrow();
 });
 it("rejects terminal signatures that remain queued",()=>{
  expect(()=>assessHistoricalDecodeCoverage({...base,queueSignatures:["sig-a"]})).toThrow();
 });
 it("rejects duplicate signatures in the source backfill window",()=>{
  expect(()=>assessHistoricalDecodeCoverage({...base,state:{...state,signatures:[...signatures,signatures[0]!]} })).toThrow();
 });
});
