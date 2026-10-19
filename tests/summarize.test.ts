import { describe, expect, it } from "vitest";
import { splitSentences, summarize } from "../src/summarize.js";

describe("splitSentences", () => {
  it("splits on sentence boundaries", () => {
    expect(splitSentences("First. Second! Third?")).toEqual([
      "First.",
      "Second!",
      "Third?",
    ]);
  });

  it("collapses whitespace", () => {
    expect(splitSentences("A.   B.")).toEqual(["A.", "B."]);
  });
});

describe("summarize", () => {
  const text =
    "This proposal requests 750000 USDC from the treasury. " +
    "Funds go to the grants program for builders. " +
    "The grants program distributes funds with monthly reporting. " +
    "Unspent funds return to the treasury at quarter end.";

  it("returns at most maxSentences in original order", () => {
    const s = summarize(text, 2);
    expect(s.sentences).toHaveLength(2);
    expect(s.text).toBe(s.sentences.join(" "));
    // original order preserved
    expect(text.indexOf(s.sentences[0])).toBeLessThan(
      text.indexOf(s.sentences[1]),
    );
  });

  it("picks the most informative sentence first when asked for one", () => {
    const s = summarize(text, 1);
    expect(s.sentences).toHaveLength(1);
    // the treasury sentence carries the key terms (treasury, 750000, usdc)
    expect(s.sentences[0]).toContain("treasury");
  });

  it("extracts keywords", () => {
    const s = summarize(text, 3);
    expect(s.keywords.length).toBeGreaterThan(0);
    expect(s.keywords).toContain("treasury");
    expect(s.keywords).toContain("funds");
  });

  it("handles empty input", () => {
    expect(summarize("", 3)).toEqual({ sentences: [], text: "", keywords: [] });
  });

  it("caps at the number of available sentences", () => {
    const s = summarize("Only one sentence.", 5);
    expect(s.sentences).toEqual(["Only one sentence."]);
  });
});
