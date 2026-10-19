/**
 * Tests for src/adapters-tally.ts: pure response mappers and the live
 * adapter with a stubbed global fetch. No live network in tests.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AdapterError,
  TALLY_API_KEY_ENV,
  TallyAdapter,
  mapTallyProposal,
  mapTallyVote,
} from "../src/adapters-tally.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetchOnce(payload: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(payload),
    }),
  );
}

const TALLY_PROPOSAL = {
  id: "eip155:1:0xgov:42",
  onchainId: "42",
  title: "Upgrade the timelock delay",
  description: "Increase the timelock delay to 2 days.",
  proposer: { address: "0xproposer" },
  governor: { id: "eip155:1:0xgov", name: "Example DAO", quorum: "400000" },
  statusChanges: [
    { type: "PENDING", start: { timestamp: 1700000000 } },
    { type: "ACTIVE", start: { timestamp: 1700001000 } },
  ],
  block: { timestamp: 1699999999 },
};

describe("mapTallyProposal", () => {
  it("maps a full Tally record, latest status wins", () => {
    const p = mapTallyProposal(TALLY_PROPOSAL, { governorId: "eip155:1:0xgov" });
    expect(p.id).toBe("eip155:1:0xgov:42");
    expect(p.source).toBe("tally");
    expect(p.state).toBe("active"); // last status change
    expect(p.author).toBe("0xproposer");
    expect(p.choices).toEqual([
      { index: 1, label: "For" },
      { index: 2, label: "Against" },
      { index: 3, label: "Abstain" },
    ]);
    expect(p.quorum).toBe("400000");
    expect(p.createdAt).toBe(1699999999);
    expect(p.metadata).toMatchObject({
      onchainId: "42",
      governorName: "Example DAO",
    });
  });

  it.each([
    ["PENDING", "pending"],
    ["ACTIVE", "active"],
    ["CANCELED", "canceled"],
    ["EXECUTED", "executed"],
    ["DEFEATED", "closed"],
    ["SUCCEEDED", "closed"],
    ["QUEUED", "closed"],
    ["EXPIRED", "closed"],
  ] as Array<[string, string]>)("maps status %s to %s", (status, expected) => {
    const p = mapTallyProposal({
      ...TALLY_PROPOSAL,
      statusChanges: [{ type: status, start: { timestamp: 1 } }],
    });
    expect(p.state).toBe(expected);
  });

  it("falls back to the onchain id when the title is empty", () => {
    const p = mapTallyProposal({ ...TALLY_PROPOSAL, title: "" });
    expect(p.title).toBe("42");
  });

  it("rejects malformed records", () => {
    expect(() => mapTallyProposal(null)).toThrow(AdapterError);
    expect(() =>
      mapTallyProposal({ ...TALLY_PROPOSAL, statusChanges: [] }),
    ).toThrow(AdapterError);
    expect(() =>
      mapTallyProposal({
        ...TALLY_PROPOSAL,
        statusChanges: [{ type: "FROBNICATED", start: { timestamp: 1 } }],
      }),
    ).toThrow(/unknown tally proposal status/);
  });
});

describe("mapTallyVote", () => {
  it.each([
    ["FOR", 1],
    ["AGAINST", 2],
    ["ABSTAIN", 3],
  ] as Array<[string, number]>)("maps support %s to choice %d", (support, choice) => {
    const v = mapTallyVote({
      voter: { address: "0xv" },
      amount: "123.45",
      support,
      reason: "LGTM",
      block: { timestamp: 1700000200 },
    });
    expect(v).toEqual({
      voter: "0xv",
      choice,
      votingPower: "123.45",
      createdAt: 1700000200,
      reason: "LGTM",
    });
  });

  it("rejects unknown support values", () => {
    expect(() =>
      mapTallyVote({
        voter: { address: "0xv" },
        amount: "1",
        support: "MAYBE",
      }),
    ).toThrow(AdapterError);
  });
});

describe("TallyAdapter", () => {
  it("refuses to construct without an API key", () => {
    expect(() => new TallyAdapter(undefined)).toThrow(
      new RegExp(TALLY_API_KEY_ENV),
    );
    expect(() => new TallyAdapter("")).toThrow(AdapterError);
  });

  it("lists proposals with the Api-Key header", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { proposals: [TALLY_PROPOSAL] } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new TallyAdapter("secret", "https://stub.test/gql");
    const proposals = await adapter.listProposals("eip155:1:0xgov", { limit: 5 });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].source).toBe("tally");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.headers).toMatchObject({ "Api-Key": "secret" });
  });

  it("requires governorId for listVotes", async () => {
    const adapter = new TallyAdapter("secret", "https://stub.test/gql");
    await expect(adapter.listVotes("42")).rejects.toThrow(/governorId/);
  });

  it("lists votes for a governor-scoped proposal", async () => {
    stubFetchOnce({
      data: {
        proposal: {
          votes: [
            {
              voter: { address: "0xv" },
              amount: "10",
              support: "FOR",
              block: { timestamp: 1700000300 },
            },
          ],
        },
      },
    });
    const adapter = new TallyAdapter("secret", "https://stub.test/gql");
    const votes = await adapter.listVotes("42", {
      governorId: "eip155:1:0xgov",
      limit: 5,
    });
    expect(votes).toEqual([
      { voter: "0xv", choice: 1, votingPower: "10", createdAt: 1700000300 },
    ]);
  });
});
