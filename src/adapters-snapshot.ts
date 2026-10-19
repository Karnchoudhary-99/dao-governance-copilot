/**
 * Snapshot adapter: pulls proposals + votes from the public Snapshot
 * offchain hub GraphQL API. No API key required.
 *
 * Endpoint: https://hub.snapshot.org/graphql
 * Query field names were verified against a live hub response
 * (proposals: id/title/body/author/state/choices/start/end/snapshot/scores/
 * scores_total/votes/created/space{id}; votes: id/voter/choice/vp/created/
 * reason).
 */
import { AdapterError, fetchAllPages, fetchGraphql, isRecord } from "./adapters.js";
import type {
  GovernanceSource,
  Proposal,
  ProposalState,
  Vote,
} from "./types.js";
import type { ProposalFetcher } from "./adapters.js";

/** Public Snapshot offchain hub GraphQL endpoint (no key required). */
export const SNAPSHOT_GRAPHQL_URL = "https://hub.snapshot.org/graphql";

const SNAPSHOT_PROPOSAL_QUERY = `
query SnapshotProposals($space: String!, $first: Int!, $skip: Int!) {
  proposals(
    first: $first
    skip: $skip
    where: { space_in: [$space] }
    orderBy: "created"
    orderDirection: desc
  ) {
    id title body author state choices start end snapshot
    scores scores_total votes created
    space { id }
  }
}`;

const SNAPSHOT_VOTES_QUERY = `
query SnapshotVotes($proposal: String!, $first: Int!, $skip: Int!) {
  votes(
    first: $first
    skip: $skip
    where: { proposal: $proposal }
    orderBy: "created"
    orderDirection: desc
  ) {
    id voter choice vp created reason
  }
}`;

const SNAPSHOT_STATES: ProposalState[] = ["pending", "active", "closed"];

/** Map a raw Snapshot hub proposal object onto the copilot domain. Pure. */
export function mapSnapshotProposal(raw: unknown): Proposal {
  if (!isRecord(raw)) throw new AdapterError("snapshot proposal must be an object");
  const str = (key: string): string => {
    const v = raw[key];
    if (typeof v !== "string" || v.length === 0) {
      throw new AdapterError(`snapshot proposal.${key} must be a non-empty string`);
    }
    return v;
  };
  const num = (key: string): number => {
    const v = raw[key];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new AdapterError(`snapshot proposal.${key} must be a finite number`);
    }
    return v;
  };
  const rawState = raw.state;
  const state: ProposalState = SNAPSHOT_STATES.includes(rawState as ProposalState)
    ? (rawState as ProposalState)
    : "closed"; // hub sometimes serves extra states — fail closed
  const choicesRaw = raw.choices;
  if (!Array.isArray(choicesRaw) || choicesRaw.length === 0) {
    throw new AdapterError("snapshot proposal.choices must be a non-empty array");
  }
  const choices = choicesRaw.map((label, i) => {
    if (typeof label !== "string") {
      throw new AdapterError(`snapshot proposal.choices[${i}] must be a string`);
    }
    return { index: i + 1, label };
  });
  const scores: Record<number, string> = {};
  const scoresRaw = raw.scores;
  if (Array.isArray(scoresRaw)) {
    scoresRaw.forEach((s, i) => {
      if (typeof s === "number" && Number.isFinite(s)) {
        scores[i + 1] = String(s);
      }
    });
  }
  const spaceId =
    isRecord(raw.space) && typeof raw.space.id === "string"
      ? raw.space.id
      : "unknown";
  // The hub exposes no quorum field: set it to 0 so quorumProgress reports 0
  // instead of a misleading ratio (analyze.ts guards division by zero).
  return {
    id: str("id"),
    title: str("title"),
    body: typeof raw.body === "string" ? raw.body : "",
    author: str("author"),
    source: "snapshot",
    state,
    choices,
    start: num("start"),
    end: num("end"),
    snapshotBlock:
      typeof raw.snapshot === "number" && Number.isFinite(raw.snapshot)
        ? raw.snapshot
        : null,
    scores,
    quorum: "0",
    createdAt: num("created"),
    metadata: { spaceId },
  };
}

/** Map a raw Snapshot hub vote onto the copilot domain. Pure. */
export function mapSnapshotVote(raw: unknown): Vote {
  if (!isRecord(raw)) throw new AdapterError("snapshot vote must be an object");
  const voter = raw.voter;
  if (typeof voter !== "string" || voter.length === 0) {
    throw new AdapterError("snapshot vote.voter must be a non-empty string");
  }
  // Single-choice ballots carry an int; weighted/quadratic ballots carry an
  // object {choiceIndex: weight} — reduce to the dominant choice.
  let choice: number;
  if (typeof raw.choice === "number" && Number.isInteger(raw.choice)) {
    choice = raw.choice;
  } else if (isRecord(raw.choice)) {
    let best = 0;
    let bestWeight = -Infinity;
    for (const [k, w] of Object.entries(raw.choice)) {
      const idx = Number(k);
      const weight = Number(w);
      if (Number.isInteger(idx) && Number.isFinite(weight) && weight > bestWeight) {
        best = idx;
        bestWeight = weight;
      }
    }
    if (best === 0) throw new AdapterError("snapshot vote.choice object had no usable entry");
    choice = best;
  } else {
    throw new AdapterError("snapshot vote.choice must be an int or a weight object");
  }
  const vp = raw.vp;
  if (typeof vp !== "number" || !Number.isFinite(vp) || vp < 0) {
    throw new AdapterError("snapshot vote.vp must be a non-negative number");
  }
  const created = raw.created;
  if (typeof created !== "number" || !Number.isFinite(created)) {
    throw new AdapterError("snapshot vote.created must be a finite number");
  }
  const vote: Vote = {
    voter,
    choice,
    votingPower: String(vp),
    createdAt: created,
  };
  if (typeof raw.reason === "string" && raw.reason.length > 0) {
    vote.reason = raw.reason;
  }
  return vote;
}

/** Live adapter for the public Snapshot offchain hub (no API key). */
export class SnapshotAdapter implements ProposalFetcher {
  readonly source: GovernanceSource = "snapshot";
  constructor(private readonly url: string = SNAPSHOT_GRAPHQL_URL) {}

  async listProposals(
    space: string,
    opts: { limit?: number } = {},
  ): Promise<Proposal[]> {
    const rows = await fetchAllPages<unknown>(opts.limit ?? 50, async (skip, first) => {
      const data = await fetchGraphql(this.url, SNAPSHOT_PROPOSAL_QUERY, {
        space,
        first,
        skip,
      });
      const proposals = data.proposals;
      if (!Array.isArray(proposals)) {
        throw new AdapterError("snapshot response missing proposals[]");
      }
      return proposals;
    });
    return rows.map(mapSnapshotProposal);
  }

  async listVotes(
    proposalId: string,
    opts: { limit?: number } = {},
  ): Promise<Vote[]> {
    const rows = await fetchAllPages<unknown>(opts.limit ?? 200, async (skip, first) => {
      const data = await fetchGraphql(this.url, SNAPSHOT_VOTES_QUERY, {
        proposal: proposalId,
        first,
        skip,
      });
      const votes = data.votes;
      if (!Array.isArray(votes)) {
        throw new AdapterError("snapshot response missing votes[]");
      }
      return votes;
    });
    return rows.map(mapSnapshotVote);
  }
}
