import { describe, expect, it } from "vitest";
import {
  buildDigestItems,
  formatCountdown,
  renderDigest,
} from "../src/digests.js";
import { Proposal } from "../src/types.js";

const NOW = 1_000_000;
const HOUR = 3600;

const mkProposal = (id: string, overrides: Partial<Proposal> = {}): Proposal => ({
  id,
  title: `Proposal ${id}`,
  body: "Move 50000 USDC from the treasury to fund the grants program.",
  author: "0xauthor",
  source: "custom",
  state: "active",
  choices: [
    { index: 1, label: "For" },
    { index: 2, label: "Against" },
  ],
  start: NOW - HOUR,
  end: NOW + 2 * HOUR,
  snapshotBlock: null,
  scores: { 1: "600", 2: "400" },
  quorum: "1000",
  createdAt: NOW - 3 * HOUR,
  ...overrides,
});

describe("formatCountdown", () => {
  it("formats days, hours and minutes", () => {
    expect(formatCountdown(2 * 24 * HOUR + 4 * HOUR)).toBe("2d 4h");
    expect(formatCountdown(90 * 60)).toBe("1h 30m");
    expect(formatCountdown(45 * 60)).toBe("45m");
  });

  it("phrases negative remaining time as 'closed … ago'", () => {
    expect(formatCountdown(-3 * HOUR)).toBe("closed 3h 0m ago");
  });
});

describe("buildDigestItems", () => {
  it("includes active proposals closing within the window", () => {
    const items = buildDigestItems(
      [mkProposal("a", { end: NOW + HOUR })],
      { now: NOW },
    );
    expect(items).toHaveLength(1);
    expect(items[0].secondsRemaining).toBe(HOUR);
  });

  it("excludes far-future active proposals and non-active states", () => {
    const proposals = [
      mkProposal("far", { end: NOW + 10 * 24 * HOUR }),
      mkProposal("closed", { state: "closed", end: NOW - HOUR }),
      mkProposal("executed", { state: "executed", end: NOW - HOUR }),
      mkProposal("canceled", { state: "canceled" }),
    ];
    expect(buildDigestItems(proposals, { now: NOW })).toHaveLength(0);
  });

  it("includes fresh pending proposals, excludes stale ones", () => {
    const proposals = [
      mkProposal("fresh", { state: "pending", createdAt: NOW - HOUR }),
      mkProposal("stale", {
        state: "pending",
        createdAt: NOW - 5 * 24 * HOUR,
      }),
    ];
    const items = buildDigestItems(proposals, { now: NOW });
    expect(items.map((i) => i.proposalId)).toEqual(["fresh"]);
  });

  it("respects custom windows", () => {
    const p = mkProposal("a", { end: NOW + 3 * HOUR });
    expect(
      buildDigestItems([p], { now: NOW, closingWithinHours: 2 }),
    ).toHaveLength(0);
    expect(
      buildDigestItems([p], { now: NOW, closingWithinHours: 4 }),
    ).toHaveLength(1);
  });

  it("sorts by urgency, least time remaining first", () => {
    const proposals = [
      mkProposal("later", { end: NOW + 5 * HOUR }),
      mkProposal("sooner", { end: NOW + HOUR }),
    ];
    const items = buildDigestItems(proposals, { now: NOW });
    expect(items.map((i) => i.proposalId)).toEqual(["sooner", "later"]);
  });

  it("attaches quorum progress and risk flags", () => {
    const [item] = buildDigestItems([mkProposal("a")], { now: NOW });
    expect(item.quorumProgress).toBeCloseTo(1.0, 5);
    expect(item.riskFlags.map((f) => f.code)).toContain("treasury-transfer");
  });
});

describe("renderDigest", () => {
  it("renders an all-quiet digest when nothing needs attention", () => {
    expect(renderDigest([])).toContain("All quiet");
  });

  it("renders each item with countdown, quorum and flags", () => {
    const items = buildDigestItems([mkProposal("a")], { now: NOW });
    const md = renderDigest(items);
    expect(md).toContain("Governance digest");
    expect(md).toContain("closes in 2h 0m");
    expect(md).toContain("100.0%");
    expect(md).toContain("treasury-transfer");
  });
});
