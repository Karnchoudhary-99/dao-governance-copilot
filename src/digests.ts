/**
 * Governance notification digests.
 *
 * Surfaces the proposals that need attention right now: active votes closing
 * soon, newly created proposals awaiting review, each with quorum progress
 * and risk flags so a daily or hourly digest tells a delegate where to look.
 */
import { DigestItem, Proposal, parseAmount } from "./types.js";
import { flagRisks } from "./risks.js";

export interface DigestOptions {
  /** Include active proposals closing within this many hours. Default 48. */
  closingWithinHours?: number;
  /** Include proposals created within this many hours. Default 72. */
  newWithinHours?: number;
  /** Unix seconds; defaults to Date.now(). Injected in tests. */
  now?: number;
}

/** Human countdown: "2d 4h", "3h 12m", "45m"; negative means already closed. */
export function formatCountdown(secondsRemaining: number): string {
  if (secondsRemaining < 0) {
    const ago = formatCountdown(-secondsRemaining);
    return `closed ${ago} ago`;
  }
  const mins = Math.floor(secondsRemaining / 60);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const rest = mins % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${rest}m`;
  return `${mins}m`;
}

function tallyScores(p: Proposal): number {
  let total = 0;
  for (const k of Object.keys(p.scores)) {
    total += parseAmount(p.scores[Number(k)]);
  }
  return total;
}

function makeItem(p: Proposal, secondsRemaining: number): DigestItem {
  const quorum = parseAmount(p.quorum);
  const total = tallyScores(p);
  return {
    proposalId: p.id,
    title: p.title,
    state: p.state,
    secondsRemaining,
    quorumProgress: quorum > 0 ? total / quorum : 0,
    riskFlags: flagRisks(p, []),
  };
}

/**
 * Build the digest: active proposals closing soon + freshly created ones,
 * sorted by urgency (least time remaining first).
 */
export function buildDigestItems(
  proposals: Proposal[],
  opts: DigestOptions = {},
): DigestItem[] {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const closingWithin = (opts.closingWithinHours ?? 48) * 3600;
  const newWithin = (opts.newWithinHours ?? 72) * 3600;
  const items: DigestItem[] = [];

  for (const p of proposals) {
    if (p.state === "active") {
      const remaining = p.end - now;
      if (remaining > 0 && remaining <= closingWithin) {
        items.push(makeItem(p, remaining));
      }
    } else if (p.state === "pending") {
      if (now - p.createdAt <= newWithin) {
        items.push(makeItem(p, p.end - now));
      }
    }
  }

  items.sort((a, b) => a.secondsRemaining - b.secondsRemaining);
  return items;
}

/** Render a digest as markdown. */
export function renderDigest(items: DigestItem[]): string {
  const lines: string[] = [];
  lines.push(`# Governance digest`);
  lines.push(``);
  if (items.length === 0) {
    lines.push(`_All quiet — no proposals closing soon or newly created._`);
    return lines.join("\n");
  }
  for (const item of items) {
    const when =
      item.secondsRemaining >= 0
        ? `closes in ${formatCountdown(item.secondsRemaining)}`
        : formatCountdown(item.secondsRemaining);
    lines.push(
      `## ${item.title} (\`${item.proposalId}\`) — ${when}`,
    );
    lines.push(``);
    lines.push(`- State: ${item.state}`);
    lines.push(
      `- Quorum progress: ${(item.quorumProgress * 100).toFixed(1)}%`,
    );
    if (item.riskFlags.length > 0) {
      lines.push(`- Risk flags:`);
      for (const f of item.riskFlags) {
        lines.push(`  - [${f.severity.toUpperCase()}] \`${f.code}\` — ${f.message}`);
      }
    }
    lines.push(``);
  }
  return lines.join("\n").trimEnd();
}
