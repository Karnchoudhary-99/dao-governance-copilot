/**
 * Tests for src/adapters-snapshot.ts: pure hub response mappers and the
 * live adapter with a stubbed global fetch. No live network in tests.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AdapterError,
  SnapshotAdapter,
  mapSnapshotProposal,
  mapSnapshotVote,
} from "../src/adapters-snapshot.js";

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

const SNAPSHOT_PROPOSAL = {
  id: "0xabc",
  title: "Fund the grants program",
  body: "We propose allocating 100k USDC to grants.",
  author: "0xauthor",
  state: "active",
  choices: ["For", "Against", "Abstain"],
  start: 1700000000,
  end: 1700604800,
  snapshot: 18900000,
  scores: [120.5, 30.25, 5],
  scores_total: 155.75,
  votes: 12,
  created: 1699900000,
  space: { id: "example.eth" },
};

describe("mapSnapshotProposal", () => {
  it("maps a full hub record", () => {
    const p = mapSnapshotProposal(SNAPSHOT_PROPOSAL);
    expect(p.id).toBe("0xabc");
    expect(p.source).toBe("snapshot");
    expect(p.state).toBe("active");
    expect(p.choices).toEqual([
      { index: 1, label: "For" },
      { index: 2, label: "Against" },
      { index: 3, label: "Abstain" },
    ]);
    expect(p.scores).toEqual({ 1: "120.5", 2: "30.25", 3: "5" });
    expect(p.snapshotBlock).toBe(18900000);
    expect(p.createdAt).toBe(1699900000);
    expect(p.metadata).toEqual({ spaceId: "example.eth" });
    // Hub exposes no quorum: expect the safe zero fallback.
    expect(p.quorum).toBe("0");
  });

  it("falls back to closed for unknown states", () => {
    const p = mapSnapshotProposal({ ...SNAPSHOT_PROPOSAL, state: "weird" });
    expect(p.state).toBe("closed");
  });

  it("tolerates a missing scores array", () => {
    const p = mapSnapshotProposal({ ...SNAPSHOT_PROPOSAL, scores: [] });
    expect(p.scores).toEqual({});
  });

  it("rejects malformed records", () => {
    expect(() => mapSnapshotProposal(null)).toThrow(AdapterError);
    expect(() => mapSnapshotProposal({ ...SNAPSHOT_PROPOSAL, title: "" })).toThrow(
      AdapterError,
    );
    expect(() => mapSnapshotProposal({ ...SNAPSHOT_PROPOSAL, choices: [] })).toThrow(
      AdapterError,
    );
  });
});

describe("mapSnapshotVote", () => {
  it("maps an int-choice ballot", () => {
    const v = mapSnapshotVote({
      voter: "0xvoter",
      choice: 2,
      vp: 42.5,
      created: 1700000100,
      reason: "against the spend",
    });
    expect(v).toEqual({
      voter: "0xvoter",
      choice: 2,
      votingPower: "42.5",
      createdAt: 1700000100,
      reason: "against the spend",
    });
  });

  it("reduces weighted-choice objects to the dominant choice", () => {
    const v = mapSnapshotVote({
      voter: "0xvoter",
      choice: { 1: 10, 3: 90 },
      vp: 100,
      created: 1700000100,
    });
    expect(v.choice).toBe(3);
    expect(v.votingPower).toBe("100");
    expect(v.reason).toBeUndefined();
  });

  it("rejects malformed ballots", () => {
    expect(() =>
      mapSnapshotVote({ voter: "", choice: 1, vp: 1, created: 1 }),
    ).toThrow(AdapterError);
    expect(() =>
      mapSnapshotVote({ voter: "0x", choice: "for", vp: 1, created: 1 }),
    ).toThrow(AdapterError);
    expect(() =>
      mapSnapshotVote({ voter: "0x", choice: 1, vp: -1, created: 1 }),
    ).toThrow(AdapterError);
  });
});

describe("SnapshotAdapter (stubbed fetch)", () => {
  const adapter = new SnapshotAdapter("https://stub.test/graphql");

  it("lists proposals through the mapper", async () => {
    stubFetchOnce({ data: { proposals: [SNAPSHOT_PROPOSAL] } });
    const proposals = await adapter.listProposals("example.eth", { limit: 10 });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].id).toBe("0xabc");
    expect(proposals[0].source).toBe("snapshot");
  });

  it("lists votes through the mapper", async () => {
    stubFetchOnce({
      data: {
        votes: [{ voter: "0xv", choice: 1, vp: 5, created: 1700000001 }],
      },
    });
    const votes = await adapter.listVotes("0xabc", { limit: 10 });
    expect(votes).toEqual([
      { voter: "0xv", choice: 1, votingPower: "5", createdAt: 1700000001 },
    ]);
  });

  it("surfaces hub failures as AdapterError", async () => {
    stubFetchOnce({ data: null, errors: [{ message: "space not found" }] });
    await expect(adapter.listProposals("nope.eth")).rejects.toThrow(AdapterError);
  });
});
