import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

function arg(name: string): string {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) ?? "";
}
const dates = arg("dates").split(",").filter(Boolean);
if (dates.length === 0 || dates.some(date => !/^\\d{4}-\\d{2}-\\d{2}$/.test(date))) {
  throw new Error("Pass --dates=YYYY-MM-DD[,YYYY-MM-DD].");
}
const ruleNames = [
  "CANDIDATE_AGE", "IMPULSE", "PULLBACK", "RECLAIM", "THREE_FLOW_WINDOWS",
  "DISTINCT_BUYERS", "BUYER_CONCENTRATION", "CREATOR_SELL_RISK", "WALLET_CLUSTER_RISK",
  "ATTRIBUTION_CONFIDENCE", "PULLBACK_VOLUME_CONTRACTION", "RECLAIM_VOLUME_EXPANSION",
  "SIGNAL_FRESHNESS", "EXECUTABLE_QUOTE", "ROUND_TRIP_COST"
] as const;
type Status = "PASS" | "FAIL" | "UNKNOWN";
type Rule = { rule: string; status: Status; actual: unknown; expected: string; reason: string };
type Audit = { decision: string; rules: Rule[]; rejectionReasons: string[]; blockingUnknownRules: string[] };
const byRule = Object.fromEntries(ruleNames.map(rule => [rule, { pass: 0, fail: 0, unknown: 0 }]));
const perDate: Record<string, unknown>[] = [];
const candidateRows: Array<{ date: string; mint: string; audit: Audit }> = [];

for (const date of dates) {
  const path = resolve("artifacts", `pump-profitability-backtest-${date}.json`);
  const report = JSON.parse(await readFile(path, "utf8")) as {
    sourceCoinCount: number;
    results: Array<{ mint: string; strictAudit: Audit | null; replayStatus: string }>;
  };
  const audited = report.results.filter(row => row.strictAudit && Array.isArray(row.strictAudit.rules));
  for (const row of audited) {
    const audit = row.strictAudit!;
    candidateRows.push({ date, mint: row.mint, audit });
    for (const rule of audit.rules) {
      if (!ruleNames.includes(rule.rule as typeof ruleNames[number])) continue;
      const counts = byRule[rule.rule as typeof ruleNames[number]];
      if (rule.status === "PASS") counts.pass++;
      else if (rule.status === "FAIL") counts.fail++;
      else counts.unknown++;
    }
  }
  perDate.push({
    date, sourceCoins: report.sourceCoinCount, auditedSetups: audited.length,
    noSetupCoins: report.results.filter(row => !row.strictAudit).length
  });
}

const singleRuleRelaxation = ruleNames.map(ruleName => {
  const newlyEligible = candidateRows.filter(({ audit }) =>
    audit.rules.length === ruleNames.length &&
    audit.rules.every(rule => rule.rule === ruleName ? rule.status === "FAIL" : rule.status === "PASS")
  );
  return { rule: ruleName, newlyEligibleCount: newlyEligible.length, mints: newlyEligible.map(row => row.mint) };
});
const blockerRanking = ruleNames.map(rule => ({
  rule, ...byRule[rule], total: byRule[rule].pass + byRule[rule].fail + byRule[rule].unknown
})).sort((a, b) => (b.fail + b.unknown) - (a.fail + a.unknown));

const report = {
  generatedAt: new Date().toISOString(),
  method: "Rule-by-rule audit diagnostics. Single-rule relaxation only counts a candidate when that one rule is FAIL and every other rule is PASS; UNKNOWN is never converted to PASS.",
  dates: perDate,
  auditedSetupCount: candidateRows.length,
  blockerRanking,
  singleRuleRelaxation,
  interpretation: [
    "FAIL means the observed setup violated the rule; relaxing it is a strategy-risk change and must be evaluated against forward outcomes.",
    "UNKNOWN means evidence is missing or uncalibrated; collect the missing evidence instead of weakening the rule.",
    "No candidate qualifies in the single-rule-relaxation test if more than one blocker exists or any other rule is UNKNOWN.",
    "This report diagnoses the first detected setup per coin only; it is not a complete intraday signal-frequency scan."
  ]
};
await mkdir("artifacts", { recursive: true });
const output = resolve("artifacts", `pump-rule-sensitivity-${dates.join("-")}.json`);
await writeFile(output, JSON.stringify(report, null, 2) + "\\n");
process.stdout.write(JSON.stringify({ ...report, artifact: output }, null, 2) + "\\n");
