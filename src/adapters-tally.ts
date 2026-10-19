/**
 * Tally adapter: pulls on-chain Governor proposals + votes from Tally's
 * GraphQL API. Requires an API key, passed as the `Api-Key` HTTP header
 * (see https://docs.tally.xyz "How to use the Tally API"; the CLI reads it
 * from the TALLY_API_KEY environment variable).
 *
 * Endpoint: https://api.tally.xyz/query
 *
 * Mapping notes:
 *  - Tally statuses map onto the copilot lifecycle: PENDING→pending,
 *    ACTIVE→active, EXECUTED→executed, CANCELED→canceled, and
 *    DEFEATED/SUCCEEDED/QUEUED/EXPIRED→closed. The latest entry in
 *    statusChanges wins.
 *  - On-chain Governor ballots use OZ support values (0=Against, 1=For,
 *    2=Abstain), normalized to the copilot's 1-based For=1/Against=2/
 *    Abstain=3 choices.
 *  - Tally returns no vote window per proposal, so start/end stay 0; quorum
 *    comes from the governor when the API returns it, else "0" (analyze.ts
 *    reports quorumProgress 0 instead of a misleading ratio).
 */
import {
  AdapterError,
  fetchAllPages,
  fetchGraphql,
  isRecord,
} from "./adapters.js";
import type { ProposalFetcher } from "./adapters.js";
import type { GovernanceSource, Proposal, ProposalState, Vote } from "./types.js";

/** Tally's GraphQL endpoint. Requires an API key via the `Api-Key` header. */
export const TALLY_GRAPHQL_URL = "https://api.tally.xyz/query";

/** Env var the CLI reads for the Tally API key. */
export const TALLY_API_KEY_ENV = "TALLY_API_KEY";

const TALLY_PROPOSALS_QUERY = `
query TallyProposals($governorIds: [AccountID!], $chainIds: [ChainID!], $limit: Int!, $offset: Int!) {
  proposals(
    governorIds: $governorIds
    chainIds: $chainIds
    pagination: { limit: $limit, offset: $offset }
    sort: { field: CREATED_AT, order: DESC }
  ) {
    id
    onchainId
    title
    description
    proposer { address }
    governor { id name quorum }
    statusChanges { type start { timestamp } }
    block { timestamp }
  }
}`;

const TALLY_VOTES_QUERY = `
query TallyVotes($governorId: AccountID!, $proposalId: String!, $limit: Int!, $offset: Int!) {
  proposal(governorId: $governorId, proposalId: $proposalId) {
    votes(pagination: { limit: $limit, offset: $offset }) {
      voter { address }
      amount
      support
      reason
      block { timestamp }
    }
  }
}`;

type TallyStatus =
  | "PENDING"
  | "ACTIVE"
  | "CANCELED"
  | "DEFEATED"
  | "SUCCEEDED"
  | "QUEUED"
  | "EXPIRED"
  | "EXECUTED";

function mapTallyStatus(status: unknown): ProposalState {
  switch (status as TallyStatus) {
    case "PENDING":
      return "pending";
    case "ACTIVE":
      return "active";
    case "EXECUTED":
      return "executed";
    case "CANCELED":
      return "canceled";
    case "DEFEATED":
    case "SUCCEEDED":
    case "QUEUED":
    case "EXPIRED":
      return "closed";
    default:
      throw new AdapterError(`unknown tally proposal status: ${String(status)}`);
  }
}

/**
 * Tally proposal status history: the adapter reads the latest status entry
 * to derive the proposal state.
 */
function latestTallyStatus(raw: Record<string, unknown>): unknown {
  const changes = raw.statusChanges;
  if (!Array.isArray(changes) || changes.length === 0) {
    throw new AdapterError("tally proposal.statusChanges must be a non-empty array");
  }
  const last = changes[changes.length - 1];
  if (!isRecord(last)) throw new AdapterError("tally statusChanges entries must be objects");
  return last.type;
}

/** Map a raw Tally proposal object onto the copilot domain. Pure. */
export function mapTallyProposal(
  raw: unknown,
  opts: { governorId?: string; chainId?: number } = {},
): Proposal {
  if (!isRecord(raw)) throw new AdapterError("tally proposal must be an object");
  const str = (key: string): string => {
    const v = raw[key];
    if (typeof v !== "string" || v.length === 0) {
      throw new AdapterError(`tally proposal.${key} must be a non-empty string`);
    }
    return v;
  };
  const proposer =
    isRecord(raw.proposer) && typeof raw.proposer.address === "string"
      ? raw.proposer.address
      : "unknown";
  const governor = isRecord(raw.governor) ? raw.governor : {};
  const quorum =
    typeof governor.quorum === "string" && governor.quorum.length > 0
      ? governor.quorum
      : "0";
  const createdBlock =
    isRecord(raw.block) && typeof raw.block.timestamp === "number"
      ? raw.block.timestamp
      : 0;
  const state = mapTallyStatus(latestTallyStatus(raw));
  // On-chain Governor proposals vote For / Against / Abstain (OZ convention:
  // support 1=For, 0=Against, 2=Abstain), normalized to our 1-based indices.
  return {
    id: str("id"),
    title: typeof raw.title === "string" && raw.title.length > 0 ? raw.title : str("onchainId"),
    body: typeof raw.description === "string" ? raw.description : "",
    author: proposer,
    source: "tally",
    state,
    choices: [
      { index: 1, label: "For" },
      { index: 2, label: "Against" },
      { index: 3, label: "Abstain" },
    ],
    start: 0,
    end: 0,
    snapshotBlock: null,
    scores: {},
    quorum,
    createdAt: createdBlock,
    metadata: {
      onchainId: typeof raw.onchainId === "string" ? raw.onchainId : null,
      governorId:
        typeof governor.id === "string" ? governor.id : (opts.governorId ?? null),
      governorName: typeof governor.name === "string" ? governor.name : null,
      chainId: opts.chainId ?? null,
    },
  };
}

/** Map a raw Tally vote onto the copilot domain. Pure. */
export function mapTallyVote(raw: unknown): Vote {
  if (!isRecord(raw)) throw new AdapterError("tally vote must be an object");
  const voter =
    isRecord(raw.voter) && typeof raw.voter.address === "string"
      ? raw.voter.address
      : null;
  if (!voter) throw new AdapterError("tally vote.voter.address must be a string");
  // OZ Governor support enum: 0=Against, 1=For, 2=Abstain → our 1-based
  // For=1 / Against=2 / Abstain=3 choices.
  const supportIndex: Record<string, number> = { FOR: 1, AGAINST: 2, ABSTAIN: 3 };
  const support = raw.support;
  const choice =
    typeof support === "string" && support in supportIndex
      ? supportIndex[support]
      : null;
  if (choice === null) {
    throw new AdapterError(`tally vote.support must be FOR/AGAINST/ABSTAIN, got ${String(support)}`);
  }
  const amount = raw.amount;
  if (typeof amount !== "string" || amount.length === 0) {
    throw new AdapterError("tally vote.amount must be a non-empty string");
  }
  const created =
    isRecord(raw.block) && typeof raw.block.timestamp === "number"
      ? raw.block.timestamp
      : 0;
  const vote: Vote = { voter, choice, votingPower: amount, createdAt: created };
  if (typeof raw.reason === "string" && raw.reason.length > 0) {
    vote.reason = raw.reason;
  }
  return vote;
}

/** Live adapter for Tally's on-chain governance API (API key required). */
export class TallyAdapter implements ProposalFetcher {
  readonly source: GovernanceSource = "tally";
  private readonly headers: Record<string, string>;

  constructor(
    apiKey: string | undefined,
    private readonly url: string = TALLY_GRAPHQL_URL,
  ) {
    if (!apiKey || apiKey.length === 0) {
      throw new AdapterError(
        `tally adapter needs an API key: set the ${TALLY_API_KEY_ENV} environment variable`,
      );
    }
    this.headers = { "Api-Key": apiKey };
  }

  async listProposals(
    governorId: string,
    opts: { limit?: number; chainIds?: number[] } = {},
  ): Promise<Proposal[]> {
    const chainIds = opts.chainIds ?? [1];
    const rows = await fetchAllPages<unknown>(opts.limit ?? 50, async (skip, first) => {
      const data = await fetchGraphql(
        this.url,
        TALLY_PROPOSALS_QUERY,
        { governorIds: [governorId], chainIds, limit: first, offset: skip },
        { headers: this.headers },
      );
      const proposals = data.proposals;
      if (!Array.isArray(proposals)) {
        throw new AdapterError("tally response missing proposals[]");
      }
      return proposals;
    });
    return rows.map((raw) =>
      mapTallyProposal(raw, { governorId, chainId: chainIds[0] }),
    );
  }

  async listVotes(
    proposalId: string,
    opts: { limit?: number; governorId?: string } = {},
  ): Promise<Vote[]> {
    if (!opts.governorId) {
      throw new AdapterError(
        "tally listVotes needs the governorId option (proposal ids are only unique per governor)",
      );
    }
    const rows = await fetchAllPages<unknown>(opts.limit ?? 200, async (skip, first) => {
      const data = await fetchGraphql(
        this.url,
        TALLY_VOTES_QUERY,
        {
          governorId: opts.governorId,
          proposalId,
          limit: first,
          offset: skip,
        },
        { headers: this.headers },
      );
      const proposal = data.proposal;
      if (!isRecord(proposal) || !Array.isArray(proposal.votes)) {
        throw new AdapterError("tally response missing proposal.votes[]");
      }
      return proposal.votes as unknown[];
    });
    return rows.map(mapTallyVote);
  }
}
