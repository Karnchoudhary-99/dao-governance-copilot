/**
 * Proposal risk flags.
 *
 * Cheap, transparent heuristics that surface the patterns governance
 * reviewers actually worry about: treasury transfers, self-dealing
 * recipients, quorum risk, vote-manipulation signals and un-audited
 * contract upgrades. Rules are deliberately conservative (info/warning)
 * except for the patterns that are unambiguous (critical).
 */
import { Proposal, RiskFlag, Vote, parseAmount } from "./types.js";

const TREASURY_PATTERNS = [
  /\btreasury\b/i,
  /\btransfer\b.{0,40}\b(funds?|tokens?|eth|usdc|dai)\b/i,
  /\b(funds?|tokens?)\b.{0,40}\btransfer\b/i,
  /\bdisburs(e|ement|ing)\b/i,
  /\bgrant(s)?\b.{0,30}\b(program|fund|round)\b/i,
];

const UPGRADE_PATTERNS = [/\bupgrade\b/i, /\bmigrat(e|ion)\b/i, /\bdeploy\b.{0,30}\bcontract/i];
const AUDIT_PATTERNS = [/\baudit(ed|ing)?\b/i, /\bsecurity review\b/i, /\bformal verification\b/i];
const TIMELOCK_PATTERNS = [/\btimelock\b/i, /\bdelay\b.{0,20}\b(execution|upgrade)\b/i];

/** Extract the largest explicit money amount mentioned in text, e.g. "500,000 USDC". */
function extractAmounts(text: string): { amount: number; token: string }[] {
  const out: { amount: number; token: string }[] = [];
  const re = /(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s*(ETH|USDC|USDT|DAI|ARB|OP|MATIC|WBTC)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ amount: parseFloat(m[1].replace(/,/g, "")), token: m[2].toUpperCase() });
  }
  return out;
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

/** Flag proposals that move treasury funds. */
function treasuryFlags(p: Proposal): RiskFlag[] {
  const haystack = `${p.title}\n${p.body}`;
  if (!matchesAny(haystack, TREASURY_PATTERNS)) return [];

  const amounts = extractAmounts(haystack);
  const flags: RiskFlag[] = [
    {
      code: "treasury-transfer",
      message: "Proposal moves funds out of the DAO treasury — verify recipient and amount.",
      severity: "warning",
    },
  ];
  for (const { amount, token } of amounts) {
    if (amount >= 1_000_000) {
      flags.push({
        code: "large-amount",
        message: `Large transfer requested: ${amount.toLocaleString("en-US")} ${token}.`,
        severity: "warning",
      });
      break;
    }
  }
  if (!/\bcap\b/i.test(haystack) && !/\bmonthly reporting\b/i.test(haystack)) {
    flags.push({
      code: "missing-spend-controls",
      message: "No spend cap or reporting requirement mentioned for the treasury transfer.",
      severity: "info",
    });
  }
  return flags;
}

/** Flag contract upgrades without an audit mention or timelock. */
function upgradeFlags(p: Proposal): RiskFlag[] {
  const haystack = `${p.title}\n${p.body}`;
  if (!matchesAny(haystack, UPGRADE_PATTERNS)) return [];
  const flags: RiskFlag[] = [];
  if (!matchesAny(haystack, AUDIT_PATTERNS)) {
    flags.push({
      code: "unaudited-upgrade",
      message: "Contract upgrade proposed with no audit or security review mentioned.",
      severity: "critical",
    });
  }
  if (!matchesAny(haystack, TIMELOCK_PATTERNS)) {
    flags.push({
      code: "no-timelock",
      message: "No timelock or execution delay mentioned for the upgrade.",
      severity: "warning",
    });
  }
  return flags;
}

/**
 * Quorum and turnout flags from proposal scores.
 * `quorum` and scores are decimal strings (voting power units).
 */
function quorumFlags(p: Proposal): RiskFlag[] {
  const flags: RiskFlag[] = [];
  const quorum = parseAmount(p.quorum);
  if (quorum <= 0) return flags;

  let total = 0;
  for (const s of Object.values(p.scores)) total += parseAmount(s);
  const ratio = total / quorum;
  if (p.state === "active" && ratio < 0.25) {
    flags.push({
      code: "quorum-at-risk",
      message: `Only ${(ratio * 100).toFixed(1)}% of quorum reached — proposal may fail to meet quorum.`,
      severity: "warning",
    });
  }
  return flags;
}

/**
 * Vote-manipulation signals: a single voter controlling an outsized share,
 * or a last-minute vote surge from a concentrated wallet.
 */
export function votingAnomalyFlags(votes: Vote[]): RiskFlag[] {
  const flags: RiskFlag[] = [];
  if (votes.length === 0) return flags;

  let total = 0;
  for (const v of votes) total += parseAmount(v.votingPower);
  if (total <= 0) return flags;

  let maxShare = 0;
  let whale: Vote | null = null;
  for (const v of votes) {
    const share = parseAmount(v.votingPower) / total;
    if (share > maxShare) {
      maxShare = share;
      whale = v;
    }
  }
  if (maxShare > 0.5 && whale) {
    flags.push({
      code: "whale-dominance",
      message: `Single voter ${whale.voter} controls ${(maxShare * 100).toFixed(1)}% of votes cast.`,
      severity: "warning",
    });
  }
  return flags;
}

/** Run every flag rule over a proposal (and optional votes). */
export function flagRisks(p: Proposal, votes: Vote[] = []): RiskFlag[] {
  const flags: RiskFlag[] = [];
  flags.push(...treasuryFlags(p));
  flags.push(...upgradeFlags(p));
  flags.push(...quorumFlags(p));
  flags.push(...votingAnomalyFlags(votes));

  // Stable, severity-sorted, de-duplicated output.
  const seen = new Set<string>();
  const rank = { critical: 0, warning: 1, info: 2 };
  return flags
    .filter((f) => (seen.has(f.code) ? false : (seen.add(f.code), true)))
    .sort((a, b) => rank[a.severity] - rank[b.severity] || a.code.localeCompare(b.code));
}
