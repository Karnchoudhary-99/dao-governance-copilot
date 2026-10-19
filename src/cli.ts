#!/usr/bin/env node
/**
 * dao-governance-copilot CLI.
 *
 *   copilot analyze <proposal.json> [--votes votes.json] [--json]
 *   copilot fixtures <out-dir> [--count N] [--seed S]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeProposal, renderReport } from "./analyze.js";
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
      "  copilot fixtures <out-dir> [--count N] [--seed S] [--votes]",
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

  usage();
}

main().catch((err) => {
  console.error(`error: ${(err as Error).message}`);
  process.exit(1);
});
