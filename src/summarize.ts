/**
 * Extractive proposal summarizer.
 *
 * Scores sentences by term frequency (stop-word filtered) plus a small
 * position bias toward the lead sentences — the standard cheap baseline
 * for proposal-length documents. No ML dependencies, fully deterministic.
 */
import { Summary } from "./types.js";

const STOP_WORDS = new Set(
  `a an the and or but if then else when where while of at by for with
   about into through during before after above below to from up down in
   out on off over under again further once here there all any both each
   few more most other some such no nor not only own same so than too
   very can will just don should now is are was were be been being have
   has had having do does did doing would could ought i you he she it we
   they them his her its our their this that these those am as me my
   your ours yours herself himself itself themselves what which who whom
   whose because until between per via within without shall may might
   must need`
    .split(/\s+/),
);

/** Split text into sentences, preserving order. */
export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'“([])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function tokenize(sentence: string): string[] {
  return sentence
    .toLowerCase()
    .replace(/[^a-z0-9\s$%]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

/**
 * Summarize `text` into at most `maxSentences` sentences.
 * Returns the selected sentences in their original order plus keywords.
 */
export function summarize(text: string, maxSentences = 3): Summary {
  const sentences = splitSentences(text);
  if (sentences.length === 0) {
    return { sentences: [], text: "", keywords: [] };
  }

  // Term frequencies over the whole document.
  const freq = new Map<string, number>();
  const tokenized = sentences.map(tokenize);
  for (const tokens of tokenized) {
    for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
  }

  // Score = mean term frequency, with a lead bias (earlier = more important).
  const scored = tokenized.map((tokens, i) => {
    const meanFreq =
      tokens.length === 0
        ? 0
        : tokens.reduce((acc, t) => acc + (freq.get(t) ?? 0), 0) / tokens.length;
    const leadBias = 1 / (1 + i * 0.25);
    return { i, score: meanFreq * 0.7 + leadBias * 0.3 };
  });

  const limit = Math.min(maxSentences, sentences.length);
  const picked = scored
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .sort((a, b) => a.i - b.i);

  const keywords = [...freq.entries()]
    .filter(([w]) => /\d/.test(w) === false && w.length > 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([w]) => w);

  const selected = picked.map((p) => sentences[p.i]);
  return { sentences: selected, text: selected.join(" "), keywords };
}
