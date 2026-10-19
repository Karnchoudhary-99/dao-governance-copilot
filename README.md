# DAO Governance Copilot

AI copilot for DAO governance: proposal analysis, voting insights, and
delegate tracking. Built in TypeScript.

Given a governance proposal, the copilot produces a structured report —
extractive summary, keyword extraction, heuristic risk flags (treasury
transfers, unaudited upgrades, quorum risk, whale dominance), quorum
progress and the leading choice — as a library call or a CLI command.

## Quick start

```bash
npm install
npm run build

# analyze one proposal file
node dist/cli.js analyze examples/proposal-treasury.json

# analyze with vote-level analytics (--votes enables the analytics section)
node dist/cli.js analyze examples/proposal-upgrade.json --votes examples/proposal-upgrade.votes.json

# analyze a whole directory of proposals
node dist/cli.js analyze-dir examples

# delegate leaderboard over a set of proposals (+ their <id>.votes.json files)
node dist/cli.js delegates examples --top 5

# governance digest: votes closing soon + fresh proposals
node dist/cli.js digest examples --closing-within 48 --new-within 72

# generate deterministic demo fixtures (with --votes, also emits <id>.votes.json)
node dist/cli.js fixtures /tmp/proposals --count 5 --seed 42 --votes

# pull LIVE proposals from a Snapshot space (no key needed)
node dist/cli.js fetch --source snapshot --dao wpay.eth --limit 5 --votes-limit 50 --out ./fetched

# pull on-chain Governor proposals from Tally (needs TALLY_API_KEY env var)
TALLY_API_KEY=xxx node dist/cli.js fetch --source tally --dao eip155:1:0xGovernorAddress --limit 5 --out ./fetched

# run the test suite
npm test
```

## Voting analytics

When a vote list is supplied (`--votes votes.json` on the CLI, or the
`votes` argument to `analyzeProposal`), the report gains a **Voting
analytics** section:

- **Quorum** — progress, power still needed, and a linear turnout
  projection estimating the final total and when quorum will be reached.
- **Concentration** — Gini coefficient, Nakamoto coefficient, and
  top-1/top-5 voter power shares, flagging whale-dominated votes.
- **Outcome** — current leader, runner-up margin, and the voting power the
  runner-up would need to flip the result.

## Live data adapters

The whole pipeline can run on real DAO data, not just fixtures.
`src/adapters.ts` holds the shared GraphQL transport (timeout, error
surfacing, page-through helper) plus a `ProposalFetcher` interface; the
per-source adapters are:

- **Snapshot** (`src/adapters-snapshot.ts`) — the public offchain hub
  GraphQL API (`https://hub.snapshot.org/graphql`), no API key needed.
  Query field names were verified against a live hub response; weighted
  ballots are reduced to their dominant choice, and the hub's missing
  quorum field is mapped to `0` so quorum progress reports 0% instead of a
  misleading ratio.
- **Tally** (`src/adapters-tally.ts`) — on-chain Governor data via
  `https://api.tally.xyz/query`, authenticated with an API key in the
  `Api-Key` header (`TALLY_API_KEY` env var). Tally lifecycle statuses and
  OZ support values (`FOR`/`AGAINST`/`ABSTAIN`) are normalized onto the
  copilot's states and For=1/Against=2/Abstain=3 choices.

`copilot fetch` writes each proposal as `<id>.json` plus an optional
`<id>.votes.json` in the same shape as the fixtures, so every other
command (`analyze`, `delegates`, `digest`) works on fetched data unchanged:

```bash
node dist/cli.js fetch --source snapshot --dao wpay.eth --limit 5 --votes-limit 50 --out ./fetched
node dist/cli.js analyze-dir ./fetched   # proposals + votes picked up automatically
```

Verified end-to-end against the live hub: fetched a real WPAY proposal
plus ballots, then ran it through `analyze` above.

## Sample output

```
# Upgrade core contracts to v2.4 — batched settlement

## Summary
We propose upgrading the protocol's core contracts to v2.4, which
introduces batched settlement and reduces gas costs. ...

## Risk flags (2)
- [CRITICAL] `unaudited-upgrade` — Contract upgrade proposed with no
  audit or security review mentioned.
- [WARNING] `no-timelock` — No timelock or execution delay mentioned
  for the upgrade.
```

## Delegate tracking

Given a directory of proposals (each optionally paired with an
`<id>.votes.json` ballot file), the copilot builds per-delegate scorecards:

- **Participation** — share of votable proposals (`active`, `closed`,
  `executed`) the delegate actually voted on. One ballot counts per
  proposal; when a voter ballots twice, the latest vote wins.
- **Reason rate** — share of ballots carrying a written rationale.
- **Win alignment** — share of votes matching the winning choice.
- **Punctuality** — how early in the voting window the delegate votes.

Scorecards combine these into a 0–100 composite score (participation 45%,
punctuality 25%, reasons 15%, alignment 15%) with an A–F letter grade,
rendered as a leaderboard table plus a per-delegate markdown report.

```bash
node dist/cli.js delegates ./proposals --top 5
```

## Notification digests

`copilot digest` builds a ready-to-send briefing from a proposals directory:
active votes closing within the window (default 48 h) and newly created
proposals (default 72 h), sorted by urgency with quorum progress and risk
flags attached — so a scheduled digest always shows delegates what needs
their attention right now.

```bash
node dist/cli.js digest ./proposals --closing-within 24 --new-within 48
```

## Library usage

```ts
import { analyzeProposal, loadProposalsFromDir, renderReport } from "dao-governance-copilot";

const [proposal] = loadProposalsFromDir("./proposals");
const analysis = analyzeProposal(proposal);
console.log(renderReport(analysis));
```

## Roadmap

- [x] Proposal ingestion (JSON files + deterministic fixtures)
- [x] Proposal summarisation + risk flags
- [x] Voting-power and quorum analytics
- [x] Delegate tracking and scorecards
- [x] Notification digests (new proposals, closing votes)
- [x] Snapshot / Tally / on-chain data adapters
- [x] Tests + docs + MIT license

## Project layout

- `src/types.ts` — governance domain types
- `src/ingest.ts` — JSON validation, vote loading, fixture generator
- `src/summarize.ts` — extractive summarizer + keyword extraction
- `src/risks.ts` — proposal risk-flag heuristics
- `src/analyze.ts` — analysis pipeline + markdown report renderer
- `src/analytics.ts` — voting analytics: quorum projection, Gini/Nakamoto
  concentration, outcome margin + flip power
- `src/delegates.ts` — delegate tracking: profiles, composite scores +
  grades, leaderboard and scorecard rendering
- `src/digests.ts` — notification digests: closing/new proposals, urgency
  ordering, markdown rendering
- `src/adapters.ts` — live-data core: GraphQL transport, `AdapterError`,
  pagination helper, `ProposalFetcher` interface
- `src/adapters-snapshot.ts` — Snapshot hub adapter (field mapping verified
  against the live API)
- `src/adapters-tally.ts` — Tally adapter (Api-Key auth, status/support
  normalization)
- `src/cli.ts` — `copilot` command-line interface
- `tests/` — vitest suite
- `examples/` — sample proposal JSON files

## License

MIT — see [LICENSE](LICENSE).
