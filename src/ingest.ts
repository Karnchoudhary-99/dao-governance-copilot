/**
 * Proposal ingestion: load proposals from JSON files, validate them,
 * and generate realistic fixtures for demos and tests.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  GovernanceSource,
  Proposal,
  ProposalChoice,
  ProposalState,
  Vote,
  parseAmount,
} from "./types.js";

const VALID_STATES: ProposalState[] = [
  "pending",
  "active",
  "closed",
  "executed",
  "canceled",
];

const VALID_SOURCES: GovernanceSource[] = [
  "snapshot",
  "tally",
  "onchain",
  "custom",
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Type-guard + validate a single raw proposal object. Throws on invalid input. */
export function validateProposal(raw: unknown): Proposal {
  if (!isRecord(raw)) throw new Error("proposal must be an object");

  const requireString = (key: string): string => {
    const v = raw[key];
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`proposal.${key} must be a non-empty string`);
    }
    return v;
  };
  const requireNumber = (key: string): number => {
    const v = raw[key];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`proposal.${key} must be a finite number`);
    }
    return v;
  };

  const state = raw.state;
  if (!VALID_STATES.includes(state as ProposalState)) {
    throw new Error(`proposal.state must be one of ${VALID_STATES.join(", ")}`);
  }
  const source = raw.source;
  if (!VALID_SOURCES.includes(source as GovernanceSource)) {
    throw new Error(
      `proposal.source must be one of ${VALID_SOURCES.join(", ")}`,
    );
  }

  const choicesRaw = raw.choices;
  if (!Array.isArray(choicesRaw) || choicesRaw.length === 0) {
    throw new Error("proposal.choices must be a non-empty array");
  }
  const choices: ProposalChoice[] = choicesRaw.map((c, i) => {
    if (!isRecord(c) || typeof c.label !== "string") {
      throw new Error(`proposal.choices[${i}] must have a string label`);
    }
    return { index: i + 1, label: c.label };
  });

  const scores: Record<number, string> = {};
  const scoresRaw = raw.scores;
  if (scoresRaw !== undefined) {
    if (!isRecord(scoresRaw)) throw new Error("proposal.scores must be an object");
    for (const [k, v] of Object.entries(scoresRaw)) {
      if (typeof v !== "string" || Number.isNaN(Number(v))) {
        throw new Error(`proposal.scores[${k}] must be a decimal string`);
      }
      scores[Number(k)] = v;
    }
  }

  return {
    id: requireString("id"),
    title: requireString("title"),
    body: requireString("body"),
    author: requireString("author"),
    source: source as GovernanceSource,
    state: state as ProposalState,
    choices,
    start: requireNumber("start"),
    end: requireNumber("end"),
    snapshotBlock: raw.snapshotBlock === null ? null : requireNumber("snapshotBlock"),
    scores,
    quorum: typeof raw.quorum === "string" ? raw.quorum : "0",
    createdAt: requireNumber("createdAt"),
    ...(isRecord(raw.metadata) ? { metadata: raw.metadata } : {}),
  };
}

/** Load and validate every `*.json` proposal file in a directory. */
export function loadProposalsFromDir(dir: string): Proposal[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  return files.map((f) => {
    const raw = JSON.parse(readFileSync(join(dir, f), "utf8"));
    return validateProposal(raw);
  });
}

/** Load votes for a proposal from a JSON file: `{ "votes": Vote[] }`. */
export function loadVotesFromFile(path: string): Vote[] {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(raw) || !Array.isArray(raw.votes)) {
    throw new Error("votes file must contain { \"votes\": Vote[] }");
  }
  return raw.votes.map((v, i) => {
    if (
      !isRecord(v) ||
      typeof v.voter !== "string" ||
      typeof v.choice !== "number" ||
      typeof v.votingPower !== "string" ||
      typeof v.createdAt !== "number"
    ) {
      throw new Error(`votes[${i}] has an invalid shape`);
    }
    const vote: Vote = {
      voter: v.voter,
      choice: v.choice,
      votingPower: v.votingPower,
      createdAt: v.createdAt,
      ...(typeof v.reason === "string" ? { reason: v.reason } : {}),
    };
    return vote;
  });
}

const NOW = 1_769_000_000; // ~2026-01-29; fixtures are relative, never "now"

// Deterministic PRNG so fixtures are stable across runs.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BODIES = [
  "This proposal requests {amount} {token} from the DAO treasury to fund the Q3 grants program. Funds will be distributed to builders through the grants committee with monthly reporting and a hard cap of 250k per grant. Any unspent funds return to the treasury at quarter end.",
  "We propose upgrading the protocol's core contracts to v2.4, which introduces batched settlement and reduces gas costs by an estimated 18 percent. The upgrade has been audited by two independent firms and reviewed on the public audit call. A 48 hour timelock applies after the vote passes.",
  "This proposal seeks to elect a new grants committee of five members for a six month term. Nominees were selected through the public nomination process and each has published a delegate statement. Committee multisig requires 3 of 5 signatures.",
];

const TOKENS = ["USDC", "ETH", "ARB", "OP"];

/**
 * Generate `count` realistic proposals with deterministic ids/bodies.
 * `seed` controls all randomness; `state` defaults to "active".
 */
export function generateFixtures(count: number, seed = 42): Proposal[] {
  const rand = mulberry32(seed);
  const out: Proposal[] = [];
  for (let i = 0; i < count; i++) {
    const amount = Math.round((50 + rand() * 950) * 1000);
    const token = TOKENS[Math.floor(rand() * TOKENS.length)];
    const body = BODIES[i % BODIES.length].replace("{amount}", amount.toLocaleString("en-US")).replace("{token}", token);
    const forVotes = Math.round(rand() * 2_000_000);
    const againstVotes = Math.round(rand() * 1_200_000);
    const abstainVotes = Math.round(rand() * 300_000);
    const start = NOW - i * 86_400 - Math.floor(rand() * 86_400);
    out.push({
      id: `fixture-${String(i + 1).padStart(3, "0")}`,
      title: `Fixture proposal ${i + 1}: ${["treasury grant", "protocol upgrade", "committee election"][i % 3]}`,
      body,
      author: `0x${Math.floor(rand() * 0xffffffffffff).toString(16).padStart(12, "0")}`,
      source: "custom",
      state: "active",
      choices: [
        { index: 1, label: "For" },
        { index: 2, label: "Against" },
        { index: 3, label: "Abstain" },
      ],
      start,
      end: start + 5 * 86_400,
      snapshotBlock: null,
      scores: {
        1: String(forVotes),
        2: String(againstVotes),
        3: String(abstainVotes),
      },
      quorum: String(1_000_000),
      createdAt: start - 86_400,
    });
  }
  return out;
}

/**
 * Generate a deterministic per-voter ballot list for a proposal, useful for
 * demos and CLI experiments. Votes are scaled so each choice group's total
 * roughly matches the proposal's `scores`; voting power is whale-skewed so
 * concentration metrics stay interesting. Same (proposal, seed) pair always
 * yields the same ballots.
 */
export function generateFixtureVotes(p: Proposal, seed = 42): Vote[] {
  // Mix the proposal id into the seed so different proposals get different ballots.
  let seedMix = seed >>> 0;
  for (const ch of p.id) seedMix = (Math.imul(seedMix, 31) + ch.charCodeAt(0)) >>> 0;
  const rand = mulberry32(seedMix);

  const scoreKeys = Object.keys(p.scores);
  const choiceWeights: { index: number; weight: number }[] =
    scoreKeys.length > 0
      ? scoreKeys.map((k) => ({
          index: Number(k),
          weight: Math.max(parseAmount(p.scores[Number(k)]), 1),
        }))
      : p.choices.map((c) => ({ index: c.index, weight: 1 }));
  const weightTotal = choiceWeights.reduce((s, w) => s + w.weight, 0);

  const pickChoice = (): number => {
    let r = rand() * weightTotal;
    for (const w of choiceWeights) {
      r -= w.weight;
      if (r <= 0) return w.index;
    }
    return choiceWeights[choiceWeights.length - 1].index;
  };

  const voterCount = 12 + Math.floor(rand() * 20);
  const ballots: Vote[] = [];
  for (let i = 0; i < voterCount; i++) {
    // Heavy-tailed power: a few whales, many small voters.
    const rawPower = 200 * (1 + 60 * Math.pow(rand(), 5));
    const close = Math.min(p.end, NOW);
    const createdAt =
      close > p.start ? p.start + Math.floor(rand() * (close - p.start)) : p.start;
    ballots.push({
      voter: `0xfixture${String(i).padStart(3, "0")}`,
      choice: pickChoice(),
      votingPower: String(Math.max(1, Math.round(rawPower))),
      createdAt,
      ...(rand() < 0.3
        ? { reason: "Voting in the interest of long-term protocol security." }
        : {}),
    });
  }

  // Rescale each choice group to match the proposal scores, keeping the
  // whale skew inside each group.
  const target = new Map<number, number>();
  for (const w of choiceWeights) target.set(w.index, w.weight);
  const groupTotal = new Map<number, number>();
  for (const b of ballots) {
    groupTotal.set(b.choice, (groupTotal.get(b.choice) ?? 0) + Number(b.votingPower));
  }
  for (const b of ballots) {
    const total = groupTotal.get(b.choice) ?? 1;
    const want = target.get(b.choice) ?? 0;
    b.votingPower = String(Math.max(1, Math.round((Number(b.votingPower) / total) * want)));
  }
  return ballots;
}
