import { describe, expect, it } from "vitest";
import {
  analyzeVotes,
  AnalyzeVotesOptions,
  gini,
  nakamoto,
} from "../src/analytics.js";
import { Vote } from "../src/types.js";

function mkVote(voter: string, power: number, choice = 1): Vote {
  return {
    voter,
    choice,
    votingPower: String(power),
    createdAt: 1_000_000,
  };
}

function opts(partial: Partial<AnalyzeVotesOptions> = {}): AnalyzeVotesOptions {
  return {
    quorum: 1000,
    start: 0,
    end: 2000,
    now: 1000,
    perChoice: new Map([
      [1, 600],
      [2, 400],
    ]),
    labels: new Map([
      [1, "For"],
      [2, "Against"],
    ]),
    ...partial,
  };
}

describe("gini", () => {
  it("is 0 for a perfectly equal distribution", () => {
    expect(gini([1, 1, 1, 1])).toBeCloseTo(0, 10);
  });

  it("is 0.75 when one of four voters holds everything", () => {
    expect(gini([0, 0, 0, 10])).toBeCloseTo(0.75, 10);
  });

  it("is null for fewer than two voters", () => {
    expect(gini([])).toBeNull();
    expect(gini([5])).toBeNull();
  });
});

describe("nakamoto", () => {
  it("counts the fewest top voters above 50%", () => {
    expect(nakamoto([60, 30, 10])).toBe(1);
    expect(nakamoto([40, 30, 20, 10])).toBe(2);
    // exactly 50% is not a majority -> needs the third voter
    expect(nakamoto([25, 25, 25, 25])).toBe(3);
  });

  it("is null with no votes", () => {
    expect(nakamoto([])).toBeNull();
  });
});

describe("analyzeVotes", () => {
  it("aggregates per-voter power and reports concentration", () => {
    const votes = [
      mkVote("0xa", 500, 1),
      mkVote("0xa", 300, 1), // same voter votes twice
      mkVote("0xb", 100, 2),
      mkVote("0xc", 100, 2),
    ];
    const a = analyzeVotes(votes, opts({ now: 2500 })); // after close
    expect(a.concentration.uniqueVoters).toBe(3);
    expect(a.concentration.top1Share).toBeCloseTo(0.8, 10);
    expect(a.concentration.top5Share).toBeCloseTo(1, 10);
    expect(a.concentration.nakamoto).toBe(1);
    expect(a.concentration.gini).toBeGreaterThan(0.4);
    expect(a.quorum.total).toBe(1000);
    expect(a.quorum.met).toBe(true);
    expect(a.quorum.remaining).toBe(0);
    // voting ended: projection collapses to the observed total
    expect(a.quorum.projectedTotal).toBe(1000);
    expect(a.quorum.quorumExpectedAt).toBe(2500);
  });

  it("projects turnout linearly and flags missed quorum", () => {
    const votes = [mkVote("0xa", 1000, 1)];
    const a = analyzeVotes(votes, opts({ quorum: 4000 }));
    // 1000 power over 1000s => 1/s; projected 2000 by close
    expect(a.quorum.projectedTotal).toBeCloseTo(2000, 6);
    expect(a.quorum.projectedProgress).toBeCloseTo(0.5, 10);
    // quorum would be reached at t=4000s, after the t=2000s deadline
    expect(a.quorum.quorumExpectedAt).toBeNull();
    expect(a.quorum.met).toBe(false);
    expect(a.quorum.remaining).toBe(3000);
  });

  it("projects when quorum will be reached", () => {
    const votes = [mkVote("0xa", 1000, 1)];
    const a = analyzeVotes(votes, opts({ quorum: 1500 }));
    // needs 1500 at 1/s from t=0 -> t=1500
    expect(a.quorum.quorumExpectedAt).toBe(1500);
    expect(a.quorum.projectedTotal).toBeCloseTo(2000, 6);
  });

  it("computes leader margin and flip power from on-chain scores", () => {
    const a = analyzeVotes([], opts());
    expect(a.outcome.leader).toBe("For");
    expect(a.outcome.runnerUp).toBe("Against");
    expect(a.outcome.margin).toBe(200);
    // runner-up needs just over half the margin
    expect(a.outcome.flipPower).toBe(101);
  });

  it("reports undecided outcome and null concentration with no data", () => {
    const a = analyzeVotes([], opts({ perChoice: new Map(), quorum: 500 }));
    expect(a.outcome.leader).toBeNull();
    expect(a.outcome.margin).toBe(0);
    expect(a.outcome.flipPower).toBeNull();
    expect(a.concentration.gini).toBeNull();
    expect(a.concentration.nakamoto).toBeNull();
    expect(a.concentration.top1Share).toBe(0);
    expect(a.quorum.total).toBe(0);
    expect(a.quorum.met).toBe(false);
    expect(a.quorum.remaining).toBe(500);
  });

  it("skips zero-power votes and handles a pending proposal", () => {
    const votes = [mkVote("0xa", 0, 1), mkVote("0xb", 250, 2)];
    const a = analyzeVotes(votes, opts({ now: -100 })); // before start
    expect(a.quorum.total).toBe(250);
    expect(a.quorum.projectedTotal).toBeNull(); // no trajectory before start
  });
});
