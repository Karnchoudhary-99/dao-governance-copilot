/**
 * Analyzer: build the structured `ProposalAnalysis` report the copilot
 * shows for a proposal — summary, risk flags, quorum progress and the
 * leading choice, all from the raw proposal + its votes.
 */
import { flagRisks } from "./risks.js";
import { summarize } from "./summarize.js";
import { Proposal, ProposalAnalysis, Vote, parseAmount } from "./types.js";

/** Aggregate votes per choice index; also returns the grand total. */
export function tallyVotes(
  votes: Vote[],
): { perChoice: Map<number, number>; total: number } {
  const perChoice = new Map<number, number>();
  let total = 0;
  for (const v of votes) {
    const power = parseAmount(v.votingPower);
    perChoice.set(v.choice, (perChoice.get(v.choice) ?? 0) + power);
    total += power;
  }
  return { perChoice, total };
}

/** Build the full copilot report for one proposal. */
export function analyzeProposal(p: Proposal, votes: Vote[] = []): ProposalAnalysis {
  const summary = summarize(p.body, 3);
  const riskFlags = flagRisks(p, votes);

  // Prefer on-chain scores when present; fall back to supplied votes.
  const scoreKeys = Object.keys(p.scores);
  let perChoice = new Map<number, number>();
  let total = 0;
  if (scoreKeys.length > 0) {
    for (const k of scoreKeys) {
      const power = parseAmount(p.scores[Number(k)]);
      perChoice.set(Number(k), power);
      total += power;
    }
  } else {
    const t = tallyVotes(votes);
    perChoice = t.perChoice;
    total = t.total;
  }

  const quorum = parseAmount(p.quorum);
  const quorumProgress = quorum > 0 ? total / quorum : 0;

  let leadingChoice: string | null = null;
  let best = -1;
  for (const c of p.choices) {
    const power = perChoice.get(c.index) ?? 0;
    if (power > best) {
      best = power;
      leadingChoice = total > 0 ? c.label : null;
    }
  }

  return {
    proposalId: p.id,
    title: p.title,
    summary,
    riskFlags,
    totalVotes: String(Math.round(total)),
    quorumProgress,
    leadingChoice,
    generatedAt: Math.floor(Date.now() / 1000),
  };
}

/** Render an analysis as a human-readable markdown report. */
export function renderReport(a: ProposalAnalysis): string {
  const lines: string[] = [];
  lines.push(`# ${a.title}`);
  lines.push(``);
  lines.push(`**Proposal:** \`${a.proposalId}\``);
  lines.push(``);
  lines.push(`## Summary`);
  lines.push(``);
  lines.push(a.summary.text || "_No summary available._");
  if (a.summary.keywords.length > 0) {
    lines.push(``);
    lines.push(`**Keywords:** ${a.summary.keywords.join(", ")}`);
  }
  lines.push(``);
  lines.push(`## Vote status`);
  lines.push(``);
  lines.push(`- Total votes: ${a.totalVotes}`);
  lines.push(`- Quorum progress: ${(a.quorumProgress * 100).toFixed(1)}%`);
  lines.push(`- Leading: ${a.leadingChoice ?? "none yet"}`);
  lines.push(``);
  lines.push(`## Risk flags (${a.riskFlags.length})`);
  lines.push(``);
  if (a.riskFlags.length === 0) {
    lines.push(`No risks flagged.`);
  } else {
    for (const f of a.riskFlags) {
      lines.push(`- [${f.severity.toUpperCase()}] \`${f.code}\` — ${f.message}`);
    }
  }
  lines.push(``);
  return lines.join("\n");
}
