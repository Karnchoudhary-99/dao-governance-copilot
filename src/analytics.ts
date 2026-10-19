/**
 * Voting-power and quorum analytics.
 *
 * Turns a raw vote list into the numbers delegates and proposal authors
 * care about while a vote is open: how close is quorum, is the current
 * trajectory on track to reach it, how concentrated is voting power, and
 * how much power it would take to flip the current leader.
 */
import { Vote, parseAmount } from "./types.js";

/** Quorum progress + linear turnout trajectory. */
export interface QuorumAnalytics {
  quorum: number;
  total: number;
  /** total / quorum, >= 0. */
  progress: number;
  /** max(0, quorum - total): power still needed. */
  remaining: number;
  met: boolean;
  /** Linear projection of total power at `end`; null when not computable. */
  projectedTotal: number | null;
  /** projectedTotal / quorum; null when projectedTotal is null. */
  projectedProgress: number | null;
  /** Unix seconds when quorum is projected to be met; null when never/unknown. */
  quorumExpectedAt: number | null;
}

/** Voting-power concentration among voters. */
export interface ConcentrationAnalytics {
  uniqueVoters: number;
  /**
   * Gini coefficient of voting power, 0 (perfect equality) … 1 (one voter
   * holds everything). Null with fewer than 2 voters.
   */
  gini: number | null;
  /**
   * Nakamoto coefficient: fewest top voters whose combined power exceeds
   * 50% of total. Null with no votes.
   */
  nakamoto: number | null;
  /** Share of total power held by the single largest voter, 0–1. */
  top1Share: number;
  /** Combined share of the five largest voters, 0–1. */
  top5Share: number;
}

/** Current leaderboard margin and flip analysis. */
export interface OutcomeAnalytics {
  leader: string | null;
  runnerUp: string | null;
  /** Leader power − runner-up power (>= 0); 0 when no votes. */
  margin: number;
  /**
   * Voting power the runner-up needs to overtake the leader. Null when the
   * race is undecided (no votes yet) or there is no runner-up.
   */
  flipPower: number | null;
}

/** Full analytics block attached to a proposal analysis. */
export interface VoteAnalytics {
  generatedAt: number;
  quorum: QuorumAnalytics;
  concentration: ConcentrationAnalytics;
  outcome: OutcomeAnalytics;
}

/** Options for {@link analyzeVotes}. */
export interface AnalyzeVotesOptions {
  /** Quorum required, in voting-power units. */
  quorum: number;
  /** Voting window, unix seconds. */
  start: number;
  end: number;
  /** "Now", unix seconds — passed explicitly so tests are deterministic. */
  now: number;
  /** Per-choice power totals (prefer on-chain scores when available). */
  perChoice: Map<number, number>;
  /** Choice index → label. */
  labels: Map<number, string>;
}

/**
 * Gini coefficient of a non-empty list of non-negative values.
 * Returns null when there are fewer than 2 values.
 */
export function gini(values: number[]): number | null {
  if (values.length < 2) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((s, x) => s + x, 0);
  if (sum <= 0) return null;
  let weighted = 0;
  for (let i = 0; i < n; i++) weighted += (i + 1) * sorted[i];
  return (2 * weighted) / (n * sum) - (n + 1) / n;
}

/**
 * Nakamoto coefficient: fewest top holders whose combined power exceeds
 * half of the total. Returns null when there are no values.
 */
export function nakamoto(values: number[]): number | null {
  if (values.length === 0) return null;
  const total = values.reduce((s, x) => s + x, 0);
  if (total <= 0) return null;
  const sorted = [...values].sort((a, b) => b - a);
  let acc = 0;
  for (let i = 0; i < sorted.length; i++) {
    acc += sorted[i];
    if (acc > total / 2) return i + 1;
  }
  return sorted.length;
}

/**
 * Build the quorum section: progress so far plus a linear trajectory
 * projection from votes cast between `start` and `now`.
 */
function analyzeQuorum(
  total: number,
  quorum: number,
  start: number,
  end: number,
  now: number,
): QuorumAnalytics {
  const progress = quorum > 0 ? total / quorum : 0;
  const met = total >= quorum;
  let projectedTotal: number | null = null;
  let projectedProgress: number | null = null;
  let quorumExpectedAt: number | null = null;

  if (met) {
    projectedTotal = total;
    quorumExpectedAt = now;
  } else if (now >= start && now < end && total > 0) {
    // Linear extrapolation: votes keep arriving at the observed average rate.
    const elapsed = Math.max(now - start, 1);
    const rate = total / elapsed;
    projectedTotal = total + rate * (end - now);
    if (rate > 0 && quorum > total) {
      quorumExpectedAt = Math.round(start + quorum / rate);
      if (quorumExpectedAt > end) quorumExpectedAt = null; // never within the window
    }
  }

  if (projectedTotal !== null) {
    projectedProgress = quorum > 0 ? projectedTotal / quorum : 0;
  }

  return {
    quorum,
    total,
    progress,
    remaining: Math.max(0, quorum - total),
    met,
    projectedTotal,
    projectedProgress,
    quorumExpectedAt,
  };
}

/** Build the concentration section from per-voter power totals. */
function analyzeConcentration(byVoter: Map<string, number>): ConcentrationAnalytics {
  const values = [...byVoter.values()];
  const total = values.reduce((s, x) => s + x, 0);
  const desc = [...values].sort((a, b) => b - a);
  const top = (k: number) =>
    total > 0 ? desc.slice(0, k).reduce((s, x) => s + x, 0) / total : 0;
  return {
    uniqueVoters: byVoter.size,
    gini: gini(values),
    nakamoto: nakamoto(values),
    top1Share: top(1),
    top5Share: top(5),
  };
}

/** Build the outcome section from per-choice power totals. */
function analyzeOutcome(
  perChoice: Map<number, number>,
  labels: Map<number, string>,
): OutcomeAnalytics {
  const ranked = [...perChoice.entries()]
    .map(([index, power]) => ({ index, power, label: labels.get(index) ?? `#${index}` }))
    .filter((c) => c.power > 0)
    .sort((a, b) => b.power - a.power);

  if (ranked.length === 0) {
    return { leader: null, runnerUp: null, margin: 0, flipPower: null };
  }
  const [first, second] = ranked;
  const margin = second ? first.power - second.power : first.power;
  // Runner-up needs just over half the margin to overtake the leader.
  const flipPower = second ? margin / 2 + 1 : null;
  return {
    leader: first.label,
    runnerUp: second ? second.label : null,
    margin,
    flipPower,
  };
}

/**
 * Compute the full voting analytics for a proposal.
 *
 * `votes` is the raw ballot list; `opts.perChoice` may carry on-chain
 * score totals which take precedence for the outcome section.
 */
export function analyzeVotes(votes: Vote[], opts: AnalyzeVotesOptions): VoteAnalytics {
  const byVoter = new Map<string, number>();
  let total = 0;
  for (const v of votes) {
    const power = parseAmount(v.votingPower);
    if (power <= 0) continue;
    byVoter.set(v.voter, (byVoter.get(v.voter) ?? 0) + power);
    total += power;
  }

  return {
    generatedAt: opts.now,
    quorum: analyzeQuorum(total, opts.quorum, opts.start, opts.end, opts.now),
    concentration: analyzeConcentration(byVoter),
    outcome: analyzeOutcome(opts.perChoice, opts.labels),
  };
}
