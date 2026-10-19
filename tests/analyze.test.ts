import { describe, expect, it } from "vitest";
import { analyzeProposal, renderReport, tallyVotes } from "../src/analyze.js";
import { Proposal, Vote } from "../src/types.js";

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: "p1",
    title: "Treasury grant for Q3",
    body: "This proposal requests 750,000 USDC from the DAO treasury to fund the Q3 grants program. Funds will be distributed with monthly reporting.",
    author: "0xabc",
    source: "snapshot",
    state: "active",
    choices: [
      { index: 1, label: "For" },
      { index: 2, label: "Against" },
    ],
    start: 1000,
    end: 2000,
    snapshotBlock: 123,
    scores: { 1: "180000", 2: "40000" },
    quorum: "1000000",
    createdAt: 900,
    ...over,
  };
}

describe("tallyVotes", () => {
  it("aggregates voting power per choice", () => {
    const votes: Vote[] = [
      { voter: "0x1", choice: 1, votingPower: "100", createdAt: 1 },
      { voter: "0x2", choice: 2, votingPower: "40", createdAt: 2 },
      { voter: "0x3", choice: 1, votingPower: "25", createdAt: 3 },
    ];
    const { perChoice, total } = tallyVotes(votes);
    expect(perChoice.get(1)).toBe(125);
    expect(perChoice.get(2)).toBe(40);
    expect(total).toBe(165);
  });
});

describe("analyzeProposal", () => {
  it("builds a complete report from proposal scores", () => {
    const a = analyzeProposal(proposal());
    expect(a.proposalId).toBe("p1");
    expect(a.title).toBe("Treasury grant for Q3");
    expect(a.summary.text.length).toBeGreaterThan(0);
    expect(a.totalVotes).toBe("220000");
    expect(a.quorumProgress).toBeCloseTo(0.22, 5);
    expect(a.leadingChoice).toBe("For");
    expect(a.riskFlags.map((f) => f.code)).toContain("treasury-transfer");
  });

  it("falls back to supplied votes when scores are absent", () => {
    const votes: Vote[] = [
      { voter: "0x1", choice: 2, votingPower: "700", createdAt: 1 },
      { voter: "0x2", choice: 1, votingPower: "100", createdAt: 2 },
    ];
    const a = analyzeProposal(proposal({ scores: {} }), votes);
    expect(a.totalVotes).toBe("800");
    expect(a.leadingChoice).toBe("Against");
  });

  it("reports no leader when nothing was voted", () => {
    const a = analyzeProposal(proposal({ scores: {}, state: "pending" }));
    expect(a.leadingChoice).toBeNull();
    expect(a.totalVotes).toBe("0");
  });
});

describe("renderReport", () => {
  it("renders a markdown report with all sections", () => {
    const md = renderReport(analyzeProposal(proposal()));
    expect(md).toContain("# Treasury grant for Q3");
    expect(md).toContain("## Summary");
    expect(md).toContain("## Vote status");
    expect(md).toContain("## Risk flags");
    expect(md).toContain("treasury-transfer");
    expect(md).toContain("22.0%");
  });
});
