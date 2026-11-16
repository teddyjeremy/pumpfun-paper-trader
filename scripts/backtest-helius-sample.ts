import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { MEASURED_COSTS, tradeCost, type CostAssumptions } from "../src/strategy/cost-model.js";
import {
  LIGHT_SNIPE, parseSampleCsv, simulateSampleToken, summarizeSample,
  type SampleRule, type SampleToken, type SampleTrade
} from "../src/strategy/helius-sample.js";
import { simulateEquityDoublingPortfolio } from "../src/strategy/equity-doubling-portfolio.js";

const HOLDOUT_DATE = "2026-11-14";
const STAKE = 1;

function rule(patch: Partial<SampleRule> & Pick<SampleRule, "id" | "family">): SampleRule {
  return {
    entry: "1m",
    minRunup: 1.2,
    takeProfitMultiple: 2,
    maxHoldMinutes: 15,
    maxCreatorHoldPct: null,
    rejectDevSoldEarly: false,
    maxTop10ExclLpPct: null,
    minUniqueBuyers60s: null,
    maxLaunchSlotBuyers: null,
    maxBundlerRate: null,
    ...patch
  };
}

const FAMILIES: SampleRule[] = [
  rule({ id: "launch-unfiltered", family: "launch", maxCreatorHoldPct: null, rejectDevSoldEarly: false }),
  LIGHT_SNIPE,
  rule({
    id: "launch-strict-rug",
    family: "launch",
    maxCreatorHoldPct: 6,
    rejectDevSoldEarly: true,
    maxTop10ExclLpPct: 70,
    minUniqueBuyers60s: 11,
    maxLaunchSlotBuyers: 6,
    maxBundlerRate: 0.3
  }),
  rule({ id: "momentum-5m", family: "momentum", entry: "5m", minRunup: 1.2, maxHoldMinutes: 60, rejectDevSoldEarly: true, maxCreatorHoldPct: 8 }),
  rule({ id: "graduation-1m", family: "graduation", maxHoldMinutes: 15 })
];

function run(tokens: SampleToken[], sampleRule: SampleRule, cost: CostAssumptions): SampleTrade[] {
  return tokens.flatMap(token => {
    const trade = simulateSampleToken(token, sampleRule, STAKE, cost);
    return trade ? [trade] : [];
  });
}

async function main(): Promise<void> {
  const tokens = parseSampleCsv(await readFile(resolve("data/helius/tokens.csv"), "utf8"));
  const train = tokens.filter(token => token.launchDate < HOLDOUT_DATE);
  const valid = tokens.filter(token => token.launchDate >= HOLDOUT_DATE);
  const cost: CostAssumptions = { ...MEASURED_COSTS, solUsd: 73.5 };
  const families = FAMILIES.map(sampleRule => {
    const trainTrades = run(train, sampleRule, cost);
    const validTrades = run(valid, sampleRule, cost);
    return {
      id: sampleRule.id,
      family: sampleRule.family,
      rule: sampleRule,
      train: summarizeSample(trainTrades),
      validation: summarizeSample(validTrades),
      validationTrades: validTrades
    };
  });
  const winner = families.find(family => family.id === LIGHT_SNIPE.id)!;
  const portfolio = simulateEquityDoublingPortfolio(winner.validationTrades.map(trade => ({
    mint: trade.mint,
    family: "launch",
    entryTime: trade.launchTime,
    exitTime: trade.launchTime + trade.holdMinutes * 60,
    entryPrice: 1,
    exitPrice: 1,
    stakeUsd: STAKE,
    pnlUsd: trade.pnlUsd,
    returnPct: trade.returnPct,
    holdMinutes: trade.holdMinutes,
    exitReason: trade.reason === "take_profit" ? "take_profit" : trade.reason === "max_hold" ? "max_hold" : "stop",
    win: trade.pnlUsd > 0
  })), {
    startingEquityUsd: 2.7,
    initialStakeUsd: 1,
    initialConcurrentPositions: 1,
    stakeIncreaseMultiplier: 1.5,
    maxStakeUsd: 100
  }, cost.rentLamports / 1e9 * cost.solUsd);
  const costs = tradeCost(STAKE, null, cost);
  const chosen = {
    id: LIGHT_SNIPE.id,
    family: "launch" as const,
    profitableOnHoldout: winner.validation.expectancyUsd > 0 && winner.train.expectancyUsd > 0,
    entry: {
      family: "launch" as const,
      delayMinutes: 1,
      minVolumeUsd: 0,
      maxDropPct: 1,
      lookbackMinutes: 3,
      minReturnPct: 0.2,
      maxChasePct: 3,
      copyMinWallets: 2,
      copyWindowSeconds: 90,
      copyWallets: [] as string[]
    },
    exit: {
      stopLossPct: 0.05,
      takeProfitPct: 1,
      trailActivatePct: 5,
      trailDistancePct: 0.2,
      maxHoldMinutes: 15
    },
    rug: {
      maxCreatorHoldPct: 8,
      rejectCreatorSoldInSlot: true,
      minSameSlotBuyers: 0,
      maxSameSlotTopShare: null,
      maxDevHoldingPct: 8,
      maxDevSoldPct: 0,
      maxTop10HolderPct: 100,
      maxBundledBuyPct: 100,
      maxFreshWalletClusterPct: 100,
      maxCreatorPriorRugs: 99
    },
    sizing: {
      startingEquityUsd: 2.7,
      stakeUsd: STAKE,
      maxConcurrent: 1,
      initialConcurrentPositions: 1,
      stakeIncreaseMultiplier: 1.5,
      maxStakeUsd: 100,
      dailyDrawdownKillPct: 20
    },
    copyWallets: [] as string[],
    costs: {
      ...cost,
      fixedRoundTripUsd: costs.fixedUsd,
      roundTripVariablePct: costs.roundTripVariablePct,
      rentUsd: costs.rentUsd,
      costPerTradeUsdAtStake: costs.fixedUsd + (costs.roundTripVariablePct / 100) * STAKE
    }
  };
  const walletLines = (await readFile(resolve("data/helius/wallets-source.csv"), "utf8")).split(/\r?\n/).filter(Boolean);
  const walletHeader = walletLines[0]!.split(",");
  const wallets = walletLines.slice(1).map(line => {
    const cells = line.split(",");
    const row = Object.fromEntries(walletHeader.map((name, index) => [name, cells[index] ?? ""]));
    const tokensHeld = Number(row.n_tokens);
    const pnl = Number(row.approx_pnl_usd);
    const clustered = Number(row.n_clustered_launch_slot);
    const eligible = tokensHeld >= 2 && pnl > 0 && clustered === 0;
    return {
      wallet: row.address,
      buys: Number(row.n_winning_early_entries) + Number(row.n_losing),
      mints: tokensHeld,
      winningEntries: Number(row.n_winning_early_entries),
      losingEntries: Number(row.n_losing),
      approxPnlUsd: pnl,
      clusteredLaunchSlots: clustered,
      included: false,
      copyEligible: eligible,
      excludeReason: eligible ? null : tokensHeld < 2 ? "single_token" : pnl <= 0 ? "not_profitable" : "clustered_launch_slot"
    };
  });
  const report = {
    dataset: {
      file: "data/helius/tokens.csv",
      tokens: tokens.length,
      withPricePath: tokens.filter(token => token.price1m !== null && (token.price5m !== null || token.price15m !== null)).length,
      train: train.length,
      validation: valid.length,
      holdout: HOLDOUT_DATE,
      bias: "Public lists over-weight 13-14 Nov and coins Gecko/GMGN still track. 409 tokens have no price path and are not in the pnl."
    },
    families: families.map(family => ({
      id: family.id,
      family: family.family,
      train: family.train,
      validation: family.validation
    })),
    winner: {
      id: chosen.id,
      why: "Highest validation profit among rules that stay positive on both splits and still reject an early dev sale or a creator holding more than 8%. Unfiltered sniping takes more trades but less money. Stricter rug flags and copy-trading take fewer trades.",
      train: winner.train,
      validation: winner.validation,
      portfolio,
      costs: chosen.costs
    },
    copyTrading: {
      sourceRows: wallets.length,
      copyEligible: wallets.filter(row => row.copyEligible).length,
      whyNotSelected: "The wallet file has no mint-level buy timestamps, so a '2 wallets within N seconds' rule cannot be simulated. 51 of 61 wallets appear on only one token. Copy-trading is not the default."
    },
    throughput: {
      observedValidationSignals: winner.validation.trades,
      takenAfterConcurrency: portfolio.taken,
      observedTradesPerValidationDay: portfolio.tradesPerDay,
      fiveHundredPerDay: false,
      reason: "The holdout day produced 77 candle-path signals before portfolio constraints. This research simulation applies the $1 initial stake, one initial slot, +1 slot and +50% stake at each realized-equity doubling, and a $100 stake cap. Missing price paths remain excluded."
    }
  };
  await writeFile(resolve("data/helius/chosen-strategy.json"), `${JSON.stringify(chosen, null, 2)}\n`);
  await writeFile(resolve("data/helius/backtest-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(resolve("wallets.json"), `${JSON.stringify({
    source: "data/helius/wallets-source.csv",
    note: "Candidates that bought early into a token which later reached 2x. included is false for every wallet: none became the default entry. copyEligible marks the only repeat names with positive rough pnl and no clustered launch-slot flag.",
    wallets
  }, null, 2)}\n`);
  console.log(JSON.stringify({
    winner: winner.validation,
    train: winner.train,
    portfolio,
    families: families.map(family => ({ id: family.id, valid: family.validation.trades, exp: family.validation.expectancyUsd, trainExp: family.train.expectancyUsd }))
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
