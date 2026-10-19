import { describe, expect, it } from "vitest";
import { flagRisks, votingAnomalyFlags } from "../src/risks.js";
import { Proposal, Vote } from "../src/types.js";

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: "p1",
    title: "Routine parameter tweak",
    body: "Adjust the fee parameter from 5 to 6 basis points.",
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
    scores: {},
    quorum: "1000",
    createdAt: 900,
    ...over,
  };
}

describe("flagRisks", () => {
  it("flags treasury transfers as warnings", () => {
    const flags = flagRisks(
      proposal({
        title: "Treasury grant",
        body: "Transfer 500,000 USDC from the treasury to the grants multisig.",
      }),
    );
    const codes = flags.map((f) => f.code);
    expect(codes).toContain("treasury-transfer");
    expect(flags.find((f) => f.code === "treasury-transfer")!.severity).toBe(
      "warning",
    );
  });

  it("flags large treasury amounts", () => {
    const flags = flagRisks(
      proposal({ body: "Disburse 2,500,000 USDC from the treasury." }),
    );
    const large = flags.find((f) => f.code === "large-amount");
    expect(large).toBeDefined();
    expect(large!.message).toContain("2,500,000 USDC");
  });

  it("flags unaudited upgrades as critical", () => {
    const flags = flagRisks(
      proposal({ body: "We propose upgrading the core contracts to v2.4 now." }),
    );
    const audit = flags.find((f) => f.code === "unaudited-upgrade");
    expect(audit).toBeDefined();
    expect(audit!.severity).toBe("critical");
  });

  it("does not flag upgrades that mention an audit and timelock", () => {
    const flags = flagRisks(
      proposal({
        body: "Upgrade the contracts to v2.4. Audited by two firms. A 48 hour timelock applies.",
      }),
    );
    expect(flags.find((f) => f.code === "unaudited-upgrade")).toBeUndefined();
    expect(flags.find((f) => f.code === "no-timelock")).toBeUndefined();
  });

  it("flags quorum-at-risk for active proposals far from quorum", () => {
    const flags = flagRisks(
      proposal({ scores: { 1: "100", 2: "50" }, quorum: "1000" }),
    );
    expect(flags.map((f) => f.code)).toContain("quorum-at-risk");
  });

  it("skips quorum flags when quorum is zero", () => {
    const flags = flagRisks(proposal({ scores: {}, quorum: "0" }));
    expect(flags.find((f) => f.code === "quorum-at-risk")).toBeUndefined();
  });

  it("returns no flags for an innocuous proposal", () => {
    expect(flagRisks(proposal())).toHaveLength(0);
  });

  it("sorts by severity: critical before warning before info", () => {
    const flags = flagRisks(
      proposal({
        title: "Upgrade and treasury grant",
        body: "Upgrade the contracts with no audit. Transfer 100 USDC from the treasury.",
      }),
    );
    const severities = flags.map((f) => f.severity);
    const rank = { critical: 0, warning: 1, info: 2 } as const;
    const ranks = severities.map((s) => rank[s]);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
  });
});

describe("votingAnomalyFlags", () => {
  function vote(voter: string, votingPower: string): Vote {
    return { voter, choice: 1, votingPower, createdAt: 1000 };
  }

  it("flags a voter with >50% of votes cast", () => {
    const flags = votingAnomalyFlags([vote("0xwhale", "600"), vote("0xsmall", "400")]);
    const whale = flags.find((f) => f.code === "whale-dominance");
    expect(whale).toBeDefined();
    expect(whale!.message).toContain("0xwhale");
  });

  it("stays silent for distributed voting power", () => {
    const flags = votingAnomalyFlags([
      vote("0xa", "300"),
      vote("0xb", "300"),
      vote("0xc", "400"),
    ]);
    expect(flags).toHaveLength(0);
  });

  it("handles empty votes", () => {
    expect(votingAnomalyFlags([])).toHaveLength(0);
  });
});
