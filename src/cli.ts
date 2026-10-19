#!/usr/bin/env node
/**
 * dao-governance-copilot CLI.
 *
 *   copilot analyze <proposal.json> [--votes votes.json] [--json]
 *   copilot fixtures <out-dir> [--count N] [--seed S]
 *   copilot fetch --source snapshot|tally --dao <space|governor-id> [--limit N]
 *     [--votes-limit N] [--out <dir>] [--chain-ids 1,10]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProposalFetcher } from "./adapters.js";
import { TALLY_API_KEY_ENV, TallyAdapter } from "./adapters-tally.js";
import { SnapshotAdapter } from "./adapters-snapshot.js";
import { analyzeProposal, renderReport } from "./analyze.js";
import {
  buildDelegateProfiles,
  renderLeaderboard,
  renderScorecard,
  scoreDelegates,
  VotesByProposal,
} from "./delegates.js";
import { buildDigestItems, renderDigest } from "./digests.js";
import {
  generateFixtureVotes,
  generateFixtures,
  loadProposalsFromDir,
  loadVotesFromFile,
  validateProposal,
} from "./ingest.js";

function usage(): never {
  console.error(
    [
      "Usage:",
      "  copilot analyze <proposal.json> [--votes <votes.json>] [--json]",
      "  copilot analyze-dir <proposals-dir> [--json]",
      "  copilot delegates <proposals-dir> [--votes-dir <dir>] [--top N]",
      "  copilot digest <proposals-dir> [--closing-within <hours>] [--new-within <hours>] [--json]",
      "  copilot fixtures <out-dir> [--count N] [--seed S] [--votes]",
      "  copilot fetch --source snapshot|tally --dao <space|governor-id> [--limit N]",
      "    [--votes-limit N] [--out <dir>] [--chain-ids 1,10]",
    ].join("\n"),
  );
  process.exit(2);
}

function getArg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

async function main(): Promise<void> {
  const [, , cmd, target] = process.argv;
  if (!cmd || !target) usage();

  if (cmd === "analyze") {
    const { readFileSync } = await import("node:fs");
    const proposal = validateProposal(JSON.parse(readFileSync(target, "utf8")));
    const votesFile = getArg("--votes");
    const votes = votesFile ? loadVotesFromFile(votesFile) : [];
    const analysis = analyzeProposal(proposal, votes);
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify(analysis, null, 2));
    } else {
      console.log(renderReport(analysis));
    }
    return;
  }

  if (cmd === "analyze-dir") {
    const proposals = loadProposalsFromDir(target);
    if (proposals.length === 0) {
      console.error(`no .json proposals found in ${target}`);
      process.exit(1);
    }
    for (const p of proposals) {
      const analysis = analyzeProposal(p);
      if (process.argv.includes("--json")) {
        console.log(JSON.stringify(analysis));
      } else {
        console.log(renderReport(analysis));
        console.log("---");
      }
    }
    return;
  }

  if (cmd === "delegates") {
    const votesDir = getArg("--votes-dir") ?? target;
    const top = Number(getArg("--top") ?? "10");
    const proposals = loadProposalsFromDir(target);
    if (proposals.length === 0) {
      console.error(`no .json proposals found in ${target}`);
      process.exit(1);
    }
    // Votes live next to proposals by default: <proposal-id>.votes.json.
    const votesByProposal: VotesByProposal = {};
    for (const p of proposals) {
      try {
        votesByProposal[p.id] = loadVotesFromFile(join(votesDir, `${p.id}.votes.json`));
      } catch {
        // No ballots on file for this proposal — it still counts toward
        // the participation denominator.
      }
    }
    const profiles = buildDelegateProfiles(proposals, votesByProposal);
    const cards = scoreDelegates(profiles);
    console.log(`# Delegate report — ${proposals.length} proposals in window`);
    console.log(``);
    console.log(renderLeaderboard(cards, top));
    for (const card of cards.slice(0, top)) {
      console.log(``);
      console.log(renderScorecard(card));
    }
    return;
  }

  if (cmd === "digest") {
    const closingWithin = Number(getArg("--closing-within") ?? "48");
    const newWithin = Number(getArg("--new-within") ?? "72");
    const proposals = loadProposalsFromDir(target);
    if (proposals.length === 0) {
      console.error(`no .json proposals found in ${target}`);
      process.exit(1);
    }
    const items = buildDigestItems(proposals, {
      closingWithinHours: closingWithin,
      newWithinHours: newWithin,
    });
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify(items, null, 2));
    } else {
      console.log(renderDigest(items));
    }
    return;
  }

  if (cmd === "fixtures") {
    const count = Number(getArg("--count") ?? "3");
    const seed = Number(getArg("--seed") ?? "42");
    const withVotes = process.argv.includes("--votes");
    mkdirSync(target, { recursive: true });
    for (const p of generateFixtures(count, seed)) {
      writeFileSync(join(target, `${p.id}.json`), JSON.stringify(p, null, 2) + "\n");
      if (withVotes) {
        const votes = generateFixtureVotes(p, seed);
        writeFileSync(
          join(target, `${p.id}.votes.json`),
          JSON.stringify({ votes }, null, 2) + "\n",
        );
      }
    }
    console.log(`wrote ${count} fixtures to ${target}${withVotes ? " (with votes)" : ""}`);
    return;
  }

  if (cmd === "fetch") {
    const source = getArg("--source") ?? "snapshot";
    const dao = getArg("--dao");
    if (!dao) {
      console.error("fetch needs --dao <snapshot space | tally governor id>");
      process.exit(1);
    }
    const limit = Number(getArg("--limit") ?? "20");
    const votesLimit = Number(getArg("--votes-limit") ?? "0");
    const out = getArg("--out") ?? "./fetched";
    const chainIds = (getArg("--chain-ids") ?? "1")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n));
    let fetcher: ProposalFetcher;
    if (source === "snapshot") {
      fetcher = new SnapshotAdapter();
    } else if (source === "tally") {
      fetcher = new TallyAdapter(process.env[TALLY_API_KEY_ENV]);
    } else {
      console.error(`unknown source: ${source} (expected snapshot|tally)`);
      process.exit(1);
    }
    mkdirSync(out, { recursive: true });
    // File names must survive ids like "eip155:1:0xgov:42".
    const safeName = (id: string): string => id.replace(/[^\w.-]/g, "_");
    const proposals = await fetcher.listProposals(dao, { limit, chainIds });
    for (const p of proposals) {
      const base = join(out, safeName(p.id));
      writeFileSync(`${base}.json`, JSON.stringify(p, null, 2) + "\n");
      if (votesLimit > 0) {
        const votes = await fetcher.listVotes(p.id, {
          limit: votesLimit,
          governorId: dao, // Tally scopes proposal ids per governor
        });
        writeFileSync(
          `${base}.votes.json`,
          JSON.stringify({ votes }, null, 2) + "\n",
        );
      }
    }
    console.log(
      `fetched ${proposals.length} proposals from ${source} into ${out}` +
        (votesLimit > 0 ? " (with votes)" : ""),
    );
    return;
  }

  usage();
}

main().catch((err) => {
  console.error(`error: ${(err as Error).message}`);
  process.exit(1);
});
