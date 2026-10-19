/**
 * Governance domain types for dao-governance-copilot.
 *
 * These model the core concepts shared by ingestion, analysis and digests:
 * proposals, votes, voting power, delegates and the structured analysis
 * report the copilot produces for each proposal.
 */

/** Lifecycle state of a governance proposal. */
export type ProposalState =
  | "pending" // created, voting has not started yet
  | "active" // currently open for voting
  | "closed" // voting ended (regardless of outcome)
  | "executed" // passed and executed on-chain
  | "canceled";

/** Where the proposal lives / how it is voted on. */
export type GovernanceSource = "snapshot" | "tally" | "onchain" | "custom";

// Type-only import: analytics.ts needs runtime values from here, so this
// direction must stay type-only to avoid a runtime module cycle.
import type { VoteAnalytics } from "./analytics.js";

/** A single ballot option (e.g. For / Against / Abstain). */
export interface ProposalChoice {
  /** 1-based index matching on-chain vote choice. */
  index: number;
  label: string;
}

/** A single vote cast on a proposal. */
export interface Vote {
  voter: string; // address or voter id
  choice: number; // ProposalChoice.index
  /** Voting power at the snapshot block, as a decimal string to avoid float loss. */
  votingPower: string;
  createdAt: number; // unix seconds
  reason?: string; // optional vote rationale (used by delegate scorecards)
}

/** A governance proposal. */
export interface Proposal {
  id: string;
  title: string;
  body: string; // markdown proposal text
  author: string;
  source: GovernanceSource;
  state: ProposalState;
  choices: ProposalChoice[];
  /** Unix seconds. */
  start: number;
  end: number;
  /** Unix seconds; null when the chain does not snapshot. */
  snapshotBlock: number | null;
  /** Voting power totals per choice index, as decimal strings. */
  scores: Record<number, string>;
  /** Quorum required for the proposal to be valid, as a decimal string. */
  quorum: string;
  createdAt: number;
  /** Arbitrary chain metadata (token address, space id, execution calldata…). */
  metadata?: Record<string, unknown>;
}

/** Aggregated profile of a delegate over a set of proposals. */
export interface DelegateProfile {
  delegate: string;
  /** Number of proposals the delegate voted on. */
  votesCast: number;
  /** Number of active proposals in the window (participation denominator). */
  proposalsInWindow: number;
  /** Average share of delegated voting power turned out, 0–1. */
  participationRate: number;
  /** Fraction of votes carrying a written reason, 0–1. */
  reasonRate: number;
  /** Share of votes matching the winning choice, 0–1 (null if no votes). */
  winAlignment: number | null;
}

/** One flagged risk on a proposal analysis. */
export interface RiskFlag {
  /** Machine-readable code, e.g. "treasury-transfer". */
  code: string;
  /** Human-readable explanation. */
  message: string;
  severity: "info" | "warning" | "critical";
}

/** Extractive summary of a proposal body. */
export interface Summary {
  /** The sentences selected, in original order. */
  sentences: string[];
  /** Plain-text summary joined with spaces. */
  text: string;
  /** Key terms driving the selection, ordered by importance. */
  keywords: string[];
}

/** The full copilot report for a proposal. */
export interface ProposalAnalysis {
  proposalId: string;
  title: string;
  summary: Summary;
  riskFlags: RiskFlag[];
  /** Total votes recorded, as a decimal string. */
  totalVotes: string;
  /** Votes cast / quorum, as a float >= 0. */
  quorumProgress: number;
  /** Winning choice label, null when no votes yet. */
  leadingChoice: string | null;
  /**
   * Vote-level analytics (quorum trajectory, concentration, flip analysis).
   * Present only when a vote list was supplied to the analyzer.
   */
  analytics?: VoteAnalytics | null;
  generatedAt: number;
}

/** One digest entry: a proposal nearing its deadline or newly created. */
export interface DigestItem {
  proposalId: string;
  title: string;
  state: ProposalState;
  /** Unix seconds until voting ends (negative when already closed). */
  secondsRemaining: number;
  quorumProgress: number;
  riskFlags: RiskFlag[];
}

/** Parse a decimal-string amount into a number; throws on invalid input. */
export function parseAmount(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`invalid amount: ${value}`);
  }
  return n;
}
