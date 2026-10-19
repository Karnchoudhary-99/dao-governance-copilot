import { describe, expect, it } from "vitest";
import {
  buildDelegateProfiles,
  renderLeaderboard,
  renderScorecard,
  scoreDelegate,
  scoreDelegates,
} from "../src/delegates.js";
import { DelegateProfile, Proposal, Vote } from "../src/types.js";

const mkProposal = (id: string, overrides: Partial<Proposal> = {}): Proposal => ({
  id,
  title: `Proposal ${id}`,
  body: "Fund the thing. Trust the team.",
  author: "0xauthor",
  source: "custom",
  state: "active",
  choices: [
    { index: 1, label: "For" },
    { index: 2, label: "Against" },
  ],
  start: 1_000_000,
  end: 1_086_400, // +24h
  snapshotBlock: null,
  scores: { 1: "600", 2: "400" },
  quorum: "100",
  createdAt: 999_000,
  ...overrides,
});

const mkVote = (
  voter: string,
  choice: number,
  power: number,
  createdAt: number,
  reason?: string,
): Vote => ({
  voter,
  choice,
  votingPower: String(power),
  createdAt,
  ...(reason === undefined ? {} : { reason }),
});

const START = 1_000_000;
const END = 1_086_400;

describe("buildDelegateProfiles", () => {
  it("counts only votable proposals in the participation denominator", () => {
    const proposals = [
      mkProposal("a"),
      mkProposal("b", { state: "closed" }),
      mkProposal("c", { state: "pending" }),
    ];
    const votes = {
      a: [mkVote("0xd1", 1, 100, START + 100)],
    };
    const [p] = buildDelegateProfiles(proposals, votes);
    expect(p.proposalsInWindow).toBe(2); // pending excluded
    expect(p.votesCast).toBe(1);
    expect(p.participationRate).toBeCloseTo(0.5, 5);
  });

  it("counts one ballot per voter per proposal, latest vote wins", () => {
    const proposals = [mkProposal("a")];
    const votes = {
      a: [
        mkVote("0xd1", 2, 100, START + 100),
        mkVote("0xd1", 1, 100, START + 200, "Changed my mind."),
      ],
    };
    const [p] = buildDelegateProfiles(proposals, votes);
    expect(p.votesCast).toBe(1);
    // Latest ballot chose the winning side (choice 1) and has a reason.
    expect(p.winAlignment).toBe(1);
    expect(p.reasonRate).toBe(1);
  });

  it("treats blank reasons as unreasoned", () => {
    const proposals = [mkProposal("a")];
    const votes = {
      a: [
        mkVote("0xd1", 1, 100, START + 100, "  "),
        mkVote("0xd2", 1, 100, START + 100, "Solid plan."),
      ],
    };
    const profiles = buildDelegateProfiles(proposals, votes);
    const d1 = profiles.find((p) => p.delegate === "0xd1")!;
    const d2 = profiles.find((p) => p.delegate === "0xd2")!;
    expect(d1.reasonRate).toBe(0);
    expect(d2.reasonRate).toBe(1);
  });

  it("derives the winner from ballots when on-chain scores are absent", () => {
    const proposals = [mkProposal("a", { scores: {} })];
    const votes = {
      a: [mkVote("0xd1", 2, 500, START + 100)],
    };
    const [p] = buildDelegateProfiles(proposals, votes);
    expect(p.winAlignment).toBe(1);
  });

  it("computes win alignment from on-chain scores across proposals", () => {
    const proposals = [mkProposal("a"), mkProposal("b")];
    const votes = {
      a: [mkVote("0xd1", 1, 100, START + 100)], // with the winner
      b: [mkVote("0xd1", 2, 100, START + 100)], // against the winner
    };
    const [p] = buildDelegateProfiles(proposals, votes);
    expect(p.winAlignment).toBeCloseTo(0.5, 5);
  });

  it("measures vote latency as share of the window, clamped to 0–1", () => {
    const proposals = [
      mkProposal("a"),
      mkProposal("b", { start: START, end: END }),
    ];
    const votes = {
      a: [mkVote("0xd1", 1, 100, START)], // right at open -> 0
      b: [mkVote("0xd1", 1, 100, END + 60_000)], // past close -> clamped to 1
    };
    const [p] = buildDelegateProfiles(proposals, votes);
    expect(p.avgLatencyShare).toBeCloseTo(0.5, 5);
  });

  it("returns an empty list when nobody voted", () => {
    expect(buildDelegateProfiles([mkProposal("a")], {})).toEqual([]);
  });

  it("sorts profiles by participation, best first", () => {
    const proposals = [mkProposal("a"), mkProposal("b")];
    const votes = {
      a: [mkVote("0xd1", 1, 100, START), mkVote("0xd2", 1, 100, START)],
      b: [mkVote("0xd1", 1, 100, START)],
    };
    const [first, second] = buildDelegateProfiles(proposals, votes);
    expect(first.delegate).toBe("0xd1");
    expect(second.delegate).toBe("0xd2");
  });
});

describe("scoreDelegate", () => {
  const base = (over: Partial<DelegateProfile>): DelegateProfile => ({
    delegate: "0xd1",
    votesCast: 0,
    proposalsInWindow: 0,
    participationRate: 0,
    reasonRate: 0,
    winAlignment: null,
    avgLatencyShare: null,
    ...over,
  });

  it("gives a perfect delegate 100 and grade A", () => {
    const s = scoreDelegate(
      base({
        participationRate: 1,
        reasonRate: 1,
        winAlignment: 1,
        avgLatencyShare: 0,
      }),
    );
    expect(s.score).toBe(100);
    expect(s.grade).toBe("A");
  });

  it("uses neutral defaults for missing alignment and latency", () => {
    const s = scoreDelegate(base({}));
    // 0*0.45 + 0*0.15 + 0.5*0.15 + 0.5*0.25 = 0.2
    expect(s.score).toBe(20);
    expect(s.grade).toBe("F");
  });

  it("weights participation highest", () => {
    const full = scoreDelegate(base({ participationRate: 1 }));
    const reasoning = scoreDelegate(base({ reasonRate: 1 }));
    expect(full.score).toBeGreaterThan(reasoning.score);
  });

  it("follows grade bands", () => {
    // participation=1 alone: 45 + 0 + 7.5 (neutral align) + 12.5 (neutral latency) = 65
    expect(scoreDelegate(base({ participationRate: 1 })).grade).toBe("B");
    // + full reason rate: 80 -> A
    expect(
      scoreDelegate(base({ participationRate: 1, reasonRate: 1 })).grade,
    ).toBe("A");
    expect(
      scoreDelegate(
        base({
          participationRate: 1,
          reasonRate: 1,
          winAlignment: 1,
          avgLatencyShare: 0,
        }),
      ).grade,
    ).toBe("A");
  });
});

describe("scoreDelegates", () => {
  it("sorts scorecards best-first", () => {
    const profiles = [
      {
        delegate: "0xweak",
        votesCast: 1,
        proposalsInWindow: 2,
        participationRate: 0.5,
        reasonRate: 0,
        winAlignment: null,
        avgLatencyShare: null,
      },
      {
        delegate: "0xstrong",
        votesCast: 2,
        proposalsInWindow: 2,
        participationRate: 1,
        reasonRate: 1,
        winAlignment: 1,
        avgLatencyShare: 0,
      },
    ];
    const [first, second] = scoreDelegates(profiles);
    expect(first.delegate).toBe("0xstrong");
    expect(second.delegate).toBe("0xweak");
  });
});

describe("rendering", () => {
  it("renders a leaderboard table and an empty-state message", () => {
    const cards = scoreDelegates([
      {
        delegate: "0xd1",
        votesCast: 2,
        proposalsInWindow: 2,
        participationRate: 1,
        reasonRate: 1,
        winAlignment: 1,
        avgLatencyShare: 0,
      },
    ]);
    const table = renderLeaderboard(cards);
    expect(table).toContain("Delegate leaderboard");
    expect(table).toContain("0xd1");
    expect(table).toContain("| A |");
    expect(renderLeaderboard([])).toContain("No delegates");
  });

  it("renders a full per-delegate scorecard", () => {
    const [card] = scoreDelegates([
      {
        delegate: "0xd1",
        votesCast: 3,
        proposalsInWindow: 5,
        participationRate: 0.6,
        reasonRate: 0.5,
        winAlignment: null,
        avgLatencyShare: 0.25,
      },
    ]);
    const md = renderScorecard(card);
    expect(md).toContain("0xd1");
    expect(md).toContain("grade");
    expect(md).toContain("Votes with the winning side: n/a");
  });
});
