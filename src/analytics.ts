/**
 * Voting-power and quorum analytics.
 *
 * Turns a raw vote list into the numbers delegates and proposal authors
 * care about while a vote is open: how close is quorum, is the current
 * trajectory on track to reach it, how concentrated is voting power, and
 * how much power it would take to flip the current leader.
 */
import { Proposal, Vote, parseAmount } from "./types.js";

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
