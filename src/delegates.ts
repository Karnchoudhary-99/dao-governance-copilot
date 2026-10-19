/**
 * Delegate tracking and scorecards.
 *
 * Aggregates per-voter ballots across a set of proposals into
 * `DelegateProfile`s (participation, rationale quality, outcome alignment,
 * voting punctuality) and turns them into composite scores + grades so the
 * copilot can answer "which delegates actually show up and do the work?".
 */
import { DelegateProfile, Proposal, Vote, parseAmount } from "./types.js";

/** Ballots keyed by proposal id. */
export type VotesByProposal = Record<string, Vote[]>;

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** Per-proposal winning choice index (null when undecidable or tied-free of votes). */
function winningChoice(p: Proposal, votes: Vote[]): number | null {
  const perChoice = new Map<number, number>();
  const scoreKeys = Object.keys(p.scores);
  if (scoreKeys.length > 0) {
    for (const k of scoreKeys) {
      perChoice.set(Number(k), parseAmount(p.scores[Number(k)]));
    }
  } else {
    for (const v of votes) {
      perChoice.set(v.choice, (perChoice.get(v.choice) ?? 0) + parseAmount(v.votingPower));
    }
  }
  if (perChoice.size === 0) return null;
  let best = -1;
  let winner: number | null = null;
  for (const [idx, power] of perChoice) {
    if (power > best) {
      best = power;
      winner = idx;
    }
  }
  return winner;
}

interface Accumulator {
  /** Proposals with a counted ballot. */
  voted: Set<string>;
  /** Ballots carrying a written reason. */
  reasoned: number;
  /** Ballots matching the winning choice. */
  aligned: number;
  /** Ballots on proposals with a determinable winner. */
  alignable: number;
  /** Sum of 0–1 vote latencies (share of the window elapsed at vote time). */
  latencySum: number;
  latencyCount: number;
}

const freshAcc = (): Accumulator => ({
  voted: new Set<string>(),
  reasoned: 0,
  aligned: 0,
  alignable: 0,
  latencySum: 0,
  latencyCount: 0,
});

/**
 * Build one `DelegateProfile` per voter across `proposals`.
 *
 * - The participation denominator is the proposals in window that reached a
 *   votable state (`active`, `closed`, `executed`).
 * - One ballot counts per voter per proposal; when a voter ballots twice,
 *   the latest `createdAt` wins (Tally-style re-voting).
 * - `winAlignment` is null when no proposal has a determinable winner.
 */
export function buildDelegateProfiles(
  proposals: Proposal[],
  votesByProposal: VotesByProposal,
): DelegateProfile[] {
  const eligible = proposals.filter((p) =>
    ["active", "closed", "executed"].includes(p.state),
  );
  const profiles: DelegateProfile[] = [];
  const accByVoter = new Map<string, Accumulator>();
  const latencyByVoter = new Map<string, { sum: number; count: number }>();

  for (const p of eligible) {
    const votes = votesByProposal[p.id] ?? [];
    // Last ballot per voter wins.
    const latest = new Map<string, Vote>();
    for (const v of votes) {
      const prev = latest.get(v.voter);
      if (!prev || v.createdAt >= prev.createdAt) latest.set(v.voter, v);
    }
    const winner = winningChoice(p, votes);
    const span = p.end - p.start;

    for (const v of latest.values()) {
      let acc = accByVoter.get(v.voter);
      if (!acc) {
        acc = freshAcc();
        accByVoter.set(v.voter, acc);
      }
      acc.voted.add(p.id);
      if (v.reason && v.reason.trim().length > 0) acc.reasoned += 1;
      if (winner !== null) {
        acc.alignable += 1;
        if (v.choice === winner) acc.aligned += 1;
      }
      if (span > 0) {
        const lat = clamp01((v.createdAt - p.start) / span);
        const l = latencyByVoter.get(v.voter) ?? { sum: 0, count: 0 };
        l.sum += lat;
        l.count += 1;
        latencyByVoter.set(v.voter, l);
      }
    }
  }

  for (const [voter, acc] of accByVoter) {
    const votesCast = acc.voted.size;
    profiles.push({
      delegate: voter,
      votesCast,
      proposalsInWindow: eligible.length,
      participationRate: eligible.length > 0 ? votesCast / eligible.length : 0,
      reasonRate: votesCast > 0 ? acc.reasoned / votesCast : 0,
      winAlignment: acc.alignable > 0 ? acc.aligned / acc.alignable : null,
      avgLatencyShare: (() => {
        const lat = latencyByVoter.get(voter);
        return lat && lat.count > 0 ? lat.sum / lat.count : null;
      })(),
    });
  }

  profiles.sort((a, b) => b.participationRate - a.participationRate);
  return profiles;
}

/** A scored profile with a letter grade for the copilot leaderboard. */
export interface DelegateScorecard extends DelegateProfile {
  /** 0–100 composite score. */
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
}

// Composite weights: showing up matters most, then doing the homework.
const WEIGHTS = { participation: 0.45, reason: 0.15, alignment: 0.15, punctuality: 0.25 };

/**
 * Turn a profile into a 0–100 composite score + letter grade.
 * Neutral values fill in for missing data: win alignment defaults to 0.5
 * (abstaining isn't evidence of bad judgment), latency defaults to 0.5 too.
 */
export function scoreDelegate(p: DelegateProfile): DelegateScorecard {
  const punctuality =
    p.avgLatencyShare == null ? 0.5 : 1 - p.avgLatencyShare;
  const score =
    100 *
    (WEIGHTS.participation * p.participationRate +
      WEIGHTS.reason * p.reasonRate +
      WEIGHTS.alignment * (p.winAlignment ?? 0.5) +
      WEIGHTS.punctuality * punctuality);
  const rounded = Math.round(score * 10) / 10;
  const grade =
    rounded >= 80 ? "A" : rounded >= 65 ? "B" : rounded >= 50 ? "C" : rounded >= 35 ? "D" : "F";
  return { ...p, score: rounded, grade };
}

/** Score every profile and sort best-first for the leaderboard. */
export function scoreDelegates(profiles: DelegateProfile[]): DelegateScorecard[] {
  return profiles.map(scoreDelegate).sort((a, b) => b.score - a.score);
}

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

/** Markdown leaderboard table, best-first. */
export function renderLeaderboard(cards: DelegateScorecard[], top = 10): string {
  const lines: string[] = [];
  lines.push(`## Delegate leaderboard`);
  lines.push(``);
  if (cards.length === 0) {
    lines.push(`_No delegates found in the voting window._`);
    return lines.join("\n");
  }
  lines.push(`| # | Delegate | Score | Grade | Votes | Participation | Reasons | Aligned |`);
  lines.push(`| --- | --- | --- | --- | --- | --- | --- | --- |`);
  cards.slice(0, top).forEach((c, i) => {
    lines.push(
      `| ${i + 1} | \`${c.delegate}\` | ${c.score.toFixed(1)} | ${c.grade} | ` +
        `${c.votesCast} | ${fmtPct(c.participationRate)} | ${fmtPct(c.reasonRate)} | ` +
        `${c.winAlignment === null ? "n/a" : fmtPct(c.winAlignment)} |`,
    );
  });
  return lines.join("\n");
}

/** One delegate's full scorecard as markdown. */
export function renderScorecard(c: DelegateScorecard): string {
  const lines: string[] = [];
  lines.push(`## Delegate \`${c.delegate}\` — grade ${c.grade} (${c.score.toFixed(1)})`);
  lines.push(``);
  lines.push(`- Votes cast: ${c.votesCast} of ${c.proposalsInWindow} proposals in window`);
  lines.push(`- Participation: ${fmtPct(c.participationRate)}`);
  lines.push(`- Votes with a written reason: ${fmtPct(c.reasonRate)}`);
  lines.push(
    `- Votes with the winning side: ${c.winAlignment === null ? "n/a" : fmtPct(c.winAlignment)}`,
  );
  lines.push(
    `- Voting punctuality: ${
      c.avgLatencyShare == null
        ? "n/a"
        : fmtPct(1 - c.avgLatencyShare) + " (mean window share unused)"
    }`,
  );
  return lines.join("\n");
}
