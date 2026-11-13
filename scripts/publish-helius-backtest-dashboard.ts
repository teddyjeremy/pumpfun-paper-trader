import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";

type Discovery = {
  provider?: string; requestedLocalDate: string; status: string; creditsUsed?: number;
  launches: Array<{ signature: string; slot: number; blockTime: number; event: { mint: string; bondingCurve: string; timestamp: string } }>;
};
type Screening = {
  date: string; status: string; creditsUsed: number; results: Array<{ index: number; result: { status: string; activityScore: number; successfulSignatures: number; activeTimeBuckets: number } }>;
  selectedLaunchIndexes: number[];
};
type Ranking = {
  date: string; selectedCoins: number; filesProcessed: number; completeCoins: number;
  incompleteCoins: number; qualifiedCoins: number; rejectedCoins: number;
  thresholds: Record<string, number>; candidates: Array<{
    mint: string; status: "QUALIFIED" | "REJECTED" | "INCOMPLETE";
    uniqueBuyers30s: number; buyTrades30s: number; sellTrades30s: number;
    buyVolumeSol30s: number; priceMovePct30s: number | null;
    peakPriceMovePct30s: number | null; realSolLiquidityAt30s: number | null; reasons: string[];
  }>;
};
const option = (name: string, fallback: string) =>
  process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const date = option("date", "");
const runId = option("run-id", "");
if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(date) || !/^\\d+$/.test(runId)) {
  throw new Error("Pass --date=YYYY-MM-DD and --run-id=<GitHub Actions run ID>.");
}
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl?.trim()) throw new Error("DATABASE_URL is required to publish historical replay data.");
const dir = resolve("artifacts");
const readOptional = async <T>(name: string): Promise<T | null> => {
  try { return JSON.parse(await readFile(resolve(dir, name), "utf8")) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};
const discovery = await readOptional<Discovery>(`pump-launch-discovery-${date}.json`);
if (!discovery || discovery.requestedLocalDate !== date || !Array.isArray(discovery.launches)) {
  throw new Error("Matching discovery artifact is required before dashboard publication.");
}
const screening = await readOptional<Screening>(`pump-launch-screen-${date}.json`);
const ranking = await readOptional<Ranking>(`pump-candidate-ranking-${date}.json`);
const checkpoint = await readOptional<{ date: string; nextCandidateIndex: number; selectedLaunchIndexes: number[]; creditsUsed?: number }>("checkpoint.json");
if (screening && (screening.date !== date || !Array.isArray(screening.results) || !Array.isArray(screening.selectedLaunchIndexes))) {
  throw new Error("Screening artifact does not match requested date or schema.");
}
if (ranking && ranking.date !== date) throw new Error("Ranking artifact belongs to another date.");
if (checkpoint && checkpoint.date !== date) throw new Error("Replay checkpoint belongs to another date.");
const rankingByMint = new Map((ranking?.candidates ?? []).map(candidate => [candidate.mint, candidate]));
const selected = new Set(screening?.selectedLaunchIndexes ?? []);
const screenRows = new Map((screening?.results ?? []).map(row => [row.index, row.result]));
const candidates = discovery.launches.map((launch, index) => {
  const screen = screenRows.get(index);
  const result = selected.has(index) ? rankingByMint.get(launch.event.mint) : undefined;
  const replayStatus = result?.status ?? (selected.has(index) ? "PENDING" : "NOT_SELECTED");
  const metrics = result ? { ...result } : {};
  return {
    index, mint: launch.event.mint, screenStatus: screen?.status ?? "NOT_SCREENED",
    activityScore: Number.isFinite(screen?.activityScore) ? screen!.activityScore : null,
    selected: selected.has(index), replayStatus, metrics
  };
});
const replayed = candidates.filter(row => row.replayStatus !== "PENDING" && row.replayStatus !== "NOT_SELECTED").length;
const complete = discovery.status === "SAMPLE_COMPLETE" && screening?.status === "COMPLETE" &&
  checkpoint?.nextCandidateIndex === selected.size && Boolean(ranking);
const status = complete ? "SAMPLE_COMPLETE" : discovery.status === "BUDGET_EXHAUSTED" ? "BUDGET_EXHAUSTED" :
  discovery.status === "INCOMPLETE" || screening?.status === "BUDGET_EXHAUSTED" ? "INCOMPLETE" :
  discovery.status === "SAMPLE_COMPLETE" ? "RUNNING" : "UNKNOWN";
const creditsUsed = Math.max(Number(discovery.creditsUsed ?? 0) + Number(screening?.creditsUsed ?? 0), Number(checkpoint?.creditsUsed ?? 0));
const summary = {
  date, provider: discovery.provider ?? "HELIUS_PARSED_EVENTS_SCAN", status,
  discoveryStatus: discovery.status, screeningStatus: screening?.status ?? null,
  discoveredCount: discovery.launches.length, screenedCount: screening?.results.length ?? 0,
  selectedCount: selected.size, replayedCount: replayed,
  completeCount: ranking?.completeCoins ?? 0, incompleteCount: ranking?.incompleteCoins ?? 0,
  qualifiedCount: ranking?.qualifiedCoins ?? 0, rejectedCount: ranking?.rejectedCoins ?? 0,
  thresholds: ranking?.thresholds ?? null, artifactRunId: runId, creditsUsed
};
const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000, idleTimeoutMillis: 5000, allowExitOnIdle: true });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query(`INSERT INTO historical_backtest_runs
    (date,provider,status,discovery_status,screening_status,discovered_count,screened_count,selected_count,
     replayed_count,complete_count,incomplete_count,qualified_count,rejected_count,credits_used,artifact_run_id,summary)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
    ON CONFLICT (date) DO UPDATE SET provider=EXCLUDED.provider,status=EXCLUDED.status,
     discovery_status=EXCLUDED.discovery_status,screening_status=EXCLUDED.screening_status,
     discovered_count=EXCLUDED.discovered_count,screened_count=EXCLUDED.screened_count,
     selected_count=EXCLUDED.selected_count,replayed_count=EXCLUDED.replayed_count,
     complete_count=EXCLUDED.complete_count,incomplete_count=EXCLUDED.incomplete_count,
     qualified_count=EXCLUDED.qualified_count,rejected_count=EXCLUDED.rejected_count,
     credits_used=EXCLUDED.credits_used,artifact_run_id=EXCLUDED.artifact_run_id,
     summary=EXCLUDED.summary,updated_at=now()`,
    [date,summary.provider,status,discovery.status,screening?.status ?? null,summary.discoveredCount,
      summary.screenedCount,summary.selectedCount,summary.replayedCount,summary.completeCount,
      summary.incompleteCount,summary.qualifiedCount,summary.rejectedCount,creditsUsed,runId,JSON.stringify(summary)]);
  for (const row of candidates) {
    await client.query(`INSERT INTO historical_backtest_candidates
      (date,discovery_index,mint,screen_status,activity_score,selected,replay_status,metrics)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
      ON CONFLICT (date,discovery_index) DO UPDATE SET mint=EXCLUDED.mint,
       screen_status=EXCLUDED.screen_status,activity_score=EXCLUDED.activity_score,
       selected=EXCLUDED.selected,replay_status=EXCLUDED.replay_status,metrics=EXCLUDED.metrics,updated_at=now()`,
      [date,row.index,row.mint,row.screenStatus,row.activityScore,row.selected,row.replayStatus,JSON.stringify(row.metrics)]);
  }
  await client.query("COMMIT");
  process.stdout.write(JSON.stringify({ ...summary, publishedCandidates: candidates.length }) + "\\n");
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
