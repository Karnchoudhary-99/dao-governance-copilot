import { describe, expect, it } from "vitest";
import {
  generateFixtureVotes,
  generateFixtures,
  loadVotesFromFile,
  validateProposal,
} from "../src/ingest.js";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = {
  id: "p1",
  title: "Test proposal",
  body: "Body text.",
  author: "0xabc",
  source: "snapshot",
  state: "active",
  choices: [{ label: "For" }, { label: "Against" }],
  start: 1000,
  end: 2000,
  snapshotBlock: 123,
  quorum: "1000",
  createdAt: 900,
};

describe("validateProposal", () => {
  it("accepts a well-formed proposal and normalizes choices", () => {
    const p = validateProposal(base);
    expect(p.choices).toEqual([
      { index: 1, label: "For" },
      { index: 2, label: "Against" },
    ]);
    expect(p.scores).toEqual({});
  });

  it("accepts null snapshotBlock", () => {
    expect(validateProposal({ ...base, snapshotBlock: null }).snapshotBlock).toBeNull();
  });

  it("rejects an unknown state", () => {
    expect(() => validateProposal({ ...base, state: "vibing" })).toThrow(/state/);
  });

  it("rejects missing title", () => {
    const { title: _t, ...rest } = base;
    expect(() => validateProposal(rest)).toThrow(/title/);
  });

  it("rejects non-object input", () => {
    expect(() => validateProposal([1, 2])).toThrow();
    expect(() => validateProposal("nope")).toThrow();
  });

  it("rejects malformed scores", () => {
    expect(() =>
      validateProposal({ ...base, scores: { 1: "not-a-number" } }),
    ).toThrow(/scores/);
  });
});

describe("loadVotesFromFile", () => {
  it("loads a well-formed votes file", () => {
    const path = join(tmpdir(), `votes-${Date.now()}.json`);
    writeFileSync(
      path,
      JSON.stringify({
        votes: [
          { voter: "0x1", choice: 1, votingPower: "100", createdAt: 1000 },
          { voter: "0x2", choice: 2, votingPower: "50", createdAt: 1001, reason: "too risky" },
        ],
      }),
    );
    const votes = loadVotesFromFile(path);
    expect(votes).toHaveLength(2);
    expect(votes[1].reason).toBe("too risky");
  });

  it("rejects files without a votes array", () => {
    const path = join(tmpdir(), `badvotes-${Date.now()}.json`);
    writeFileSync(path, JSON.stringify({ votes: "nope" }));
    expect(() => loadVotesFromFile(path)).toThrow();
  });
});

describe("generateFixtures", () => {
  it("is deterministic for the same seed", () => {
    const a = generateFixtures(5, 7);
    const b = generateFixtures(5, 7);
    expect(a).toEqual(b);
  });

  it("differs across seeds", () => {
    const a = generateFixtures(5, 7);
    const b = generateFixtures(5, 8);
    expect(a[0].id).toBe(b[0].id); // ids are positional
    expect(a[0].scores).not.toEqual(b[0].scores);
  });

  it("produces valid proposals that pass validation", () => {
    for (const p of generateFixtures(4, 99)) {
      expect(() => validateProposal(JSON.parse(JSON.stringify(p)))).not.toThrow();
      expect(p.choices).toHaveLength(3);
    }
  });
});

describe("generateFixtureVotes", () => {
  it("is deterministic for the same proposal and seed", () => {
    const [p] = generateFixtures(1, 42);
    const a = generateFixtureVotes(p, 7);
    const b = generateFixtureVotes(p, 7);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(10);
  });

  it("differs across proposals and seeds", () => {
    const [p, q] = generateFixtures(2, 42);
    expect(generateFixtureVotes(p, 7)).not.toEqual(generateFixtureVotes(q, 7));
    expect(generateFixtureVotes(p, 7)).not.toEqual(generateFixtureVotes(p, 8));
  });

  it("produces valid votes whose group totals track the proposal scores", () => {
    const [p] = generateFixtures(1, 42);
    const votes = generateFixtureVotes(p, 7);
    const validIndexes = new Set(p.choices.map((c) => c.index));
    const groupTotal = new Map<number, number>();
    for (const v of votes) {
      expect(validIndexes.has(v.choice)).toBe(true);
      expect(Number(v.votingPower)).toBeGreaterThan(0);
      expect(v.createdAt).toBeGreaterThanOrEqual(p.start);
      groupTotal.set(v.choice, (groupTotal.get(v.choice) ?? 0) + Number(v.votingPower));
    }
    for (const k of Object.keys(p.scores)) {
      const want = Number(p.scores[Number(k)]);
      const got = groupTotal.get(Number(k)) ?? 0;
      if (want > 0) {
        expect(got / want).toBeGreaterThan(0.9);
        expect(got / want).toBeLessThan(1.1);
      }
    }
    // round-trip through the file loader
    const path = join(tmpdir(), `votes-${Date.now()}.json`);
    writeFileSync(path, JSON.stringify({ votes }));
    expect(loadVotesFromFile(path)).toHaveLength(votes.length);
  });
});
