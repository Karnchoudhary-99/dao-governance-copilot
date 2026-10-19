import { describe, expect, it } from "vitest";
import {
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
