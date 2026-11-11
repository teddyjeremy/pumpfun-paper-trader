export interface DynamicExitConfig {
  enabled: boolean; confirmationWindows: number; minBearishSignalsPerWindow: number;
  buySellRatioBelow: number; buyVolumeDeclinePct: number; buyerRateDeclinePct: number;
  sellVolumeExpansionPct: number; priceResponseDeclinePct: number; liquidityDropPct: number;
}
export interface ExitWindowObservation {
  endedAtMs: number; windowSeconds: 2 | 5 | 10 | 30; complete: boolean;
  buySellRatio: number | null; buyVolumeDeclinePct: number | null; buyerRateDeclinePct: number | null;
  sellVolumeExpansionPct: number | null; priceResponseDeclinePct: number | null;
  liquidityChangePct: number | null; largeHolderDistributionDetected: boolean | null;
}
export interface ExitEvaluationInput {
  currentNetReturnPct: number; highestCompletedNetReturnPct: number;
  previousActiveStopPct?: number | null; emergencyReason?: string | null;
  freshExecutableSellQuote: boolean; windowsOldestFirst: ExitWindowObservation[];
}
export interface ExitEvaluation {
  action: "hold" | "sell" | "exit_blocked";
  reason: "no_signal" | "hard_stop" | "protective_stop" | "emergency_risk" | "dynamic_exhaustion" | "sell_quote_unavailable";
  triggerReason: string | null; activeStopPct: number; bearishSignalsByWindow: number[]; evidence: string[];
}
export const PROTECTIVE_EXIT_POLICY = Object.freeze({
  hardStopPct: -5, trailingActivationPct: 10, trailingGivebackPct: 40,
  profitLocks: [{triggerPct:10,floorPct:5},{triggerPct:50,floorPct:15},{triggerPct:100,floorPct:40},{triggerPct:200,floorPct:80}]
});
/** Initial paper-calibration values, not statistically optimized thresholds. */
export const DYNAMIC_EXIT_CALIBRATION_V1: DynamicExitConfig = Object.freeze({
  enabled:true, confirmationWindows:2, minBearishSignalsPerWindow:2, buySellRatioBelow:1,
  buyVolumeDeclinePct:40, buyerRateDeclinePct:40, sellVolumeExpansionPct:50,
  priceResponseDeclinePct:40, liquidityDropPct:20
});
export function calculateActiveStopPct(highestCompletedNetReturnPct:number, previousActiveStopPct:number|null=null):number {
  const high=Number.isFinite(highestCompletedNetReturnPct)?highestCompletedNetReturnPct:0;
  let lock=Number.NEGATIVE_INFINITY;
  for(const item of PROTECTIVE_EXIT_POLICY.profitLocks) if(high>=item.triggerPct) lock=item.floorPct;
  const trail=high>=10?((1+high/100)*(1-PROTECTIVE_EXIT_POLICY.trailingGivebackPct/100)-1)*100:Number.NEGATIVE_INFINITY;
  return Math.max(PROTECTIVE_EXIT_POLICY.hardStopPct,lock,trail,previousActiveStopPct??Number.NEGATIVE_INFINITY);
}
function bearish(window:ExitWindowObservation,c:DynamicExitConfig):string[] {
  if(!window.complete)return [];
  const s:string[]=[];
  if(window.buySellRatio!==null&&Number.isFinite(window.buySellRatio)&&window.buySellRatio<c.buySellRatioBelow)s.push("buy/sell quote-volume ratio weakened");
  if(window.buyVolumeDeclinePct!==null&&Number.isFinite(window.buyVolumeDeclinePct)&&window.buyVolumeDeclinePct>=c.buyVolumeDeclinePct)s.push("buy quote-volume contracted");
  if(window.buyerRateDeclinePct!==null&&Number.isFinite(window.buyerRateDeclinePct)&&window.buyerRateDeclinePct>=c.buyerRateDeclinePct)s.push("unique buyer rate declined");
  if(window.sellVolumeExpansionPct!==null&&Number.isFinite(window.sellVolumeExpansionPct)&&window.sellVolumeExpansionPct>=c.sellVolumeExpansionPct)s.push("sell quote-volume expanded");
  if(window.priceResponseDeclinePct!==null&&Number.isFinite(window.priceResponseDeclinePct)&&window.priceResponseDeclinePct>=c.priceResponseDeclinePct)s.push("price response to buying weakened");
  if(window.liquidityChangePct!==null&&Number.isFinite(window.liquidityChangePct)&&window.liquidityChangePct<=-c.liquidityDropPct)s.push("market liquidity deteriorated");
  if(window.largeHolderDistributionDetected===true)s.push("large-holder distribution detected");
  return s;
}
function exhaustion(windows:ExitWindowObservation[],c:DynamicExitConfig) {
  if(!c.enabled||c.confirmationWindows<1||windows.length<c.confirmationWindows)return {ok:false,counts:[] as number[],evidence:[] as string[]};
  const recent=windows.slice(-c.confirmationWindows), duration=recent[0]?.windowSeconds;
  if(!duration||recent.some(w=>!w.complete||w.windowSeconds!==duration))return {ok:false,counts:[],evidence:[] as string[]};
  for(let i=1;i<recent.length;i++){const a=recent[i-1],b=recent[i];if(!a||!b)return {ok:false,counts:[],evidence:[] as string[]};const gap=b.endedAtMs-a.endedAtMs;if(gap<=0||gap>duration*1500)return {ok:false,counts:[],evidence:[] as string[]};}
  const signals=recent.map(w=>bearish(w,c));
  return {ok:signals.every(s=>s.length>=c.minBearishSignalsPerWindow),counts:signals.map(s=>s.length),evidence:[...new Set(signals.flat())]};
}
export function evaluateExit(input:ExitEvaluationInput,c:DynamicExitConfig=DYNAMIC_EXIT_CALIBRATION_V1):ExitEvaluation {
  const stop=calculateActiveStopPct(input.highestCompletedNetReturnPct,input.previousActiveStopPct??null);
  let reason:ExitEvaluation["reason"]="no_signal", evidence:string[]=[], counts:number[]=[];
  if(input.emergencyReason){reason="emergency_risk";evidence=[input.emergencyReason];}
  else if(input.currentNetReturnPct<=-5){reason="hard_stop";evidence=["net return reached the -5% hard stop"];}
  else if(input.currentNetReturnPct<=stop){reason="protective_stop";evidence=["net return crossed the monotonic trailing/profit-lock stop"];}
  else {const d=exhaustion(input.windowsOldestFirst,c);counts=d.counts;if(d.ok){reason="dynamic_exhaustion";evidence=d.evidence;}}
  if(reason==="no_signal")return {action:"hold",reason,triggerReason:null,activeStopPct:stop,bearishSignalsByWindow:counts,evidence:[]};
  if(!input.freshExecutableSellQuote)return {action:"exit_blocked",reason:"sell_quote_unavailable",triggerReason:reason,activeStopPct:stop,bearishSignalsByWindow:counts,evidence:[...evidence,"exit signal exists but no fresh full-position sell quote is verified"]};
  return {action:"sell",reason,triggerReason:reason,activeStopPct:stop,bearishSignalsByWindow:counts,evidence};
}
