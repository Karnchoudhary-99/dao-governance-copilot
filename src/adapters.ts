/**
 * Live governance data adapters — shared core.
 *
 * Pulls proposals + votes from real governance systems and maps them onto
 * the copilot's domain types, so `analyze`, `delegates` and `digest` can run
 * on live DAO data instead of fixtures. Per-source adapters live in
 * adapters-snapshot.ts and adapters-tally.ts.
 *
 * All response *mapping* is pure and testable; network I/O is isolated in
 * fetchGraphql. Mappers validate defensively and throw AdapterError with a
 * clear message when a response does not match the expected shape.
 */
import type { GovernanceSource, Proposal, Vote } from "./types.js";

/** Thrown when a governance API call fails or returns an unexpected shape. */
export class AdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterError";
  }
}

/** Structural type-guard shared by the adapters. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Options for a single GraphQL request. */
export interface GraphqlOptions {
  /** Extra HTTP headers (e.g. Tally's `Api-Key`). */
  headers?: Record<string, string>;
  /** Abort the request after this many ms (default 15000). */
  timeoutMs?: number;
}

/**
 * POST a GraphQL query and return the `data` payload.
 * Throws AdapterError on transport failures, HTTP errors, GraphQL
 * `errors`, or an unparseable/missing `data` body.
 */
export async function fetchGraphql(
  url: string,
  query: string,
  variables: Record<string, unknown> = {},
  options: GraphqlOptions = {},
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 15000,
  );
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new AdapterError(`GraphQL request to ${url} timed out`);
    }
    throw new AdapterError(
      `GraphQL request to ${url} failed: ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) {
    throw new AdapterError(
      `GraphQL request to ${url} returned HTTP ${res.status}`,
    );
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new AdapterError(`GraphQL response from ${url} was not JSON`);
  }
  if (!isRecord(body) || !isRecord(body.data)) {
    const detail =
      isRecord(body) && Array.isArray(body.errors)
        ? JSON.stringify(body.errors).slice(0, 300)
        : "missing data";
    throw new AdapterError(`GraphQL error from ${url}: ${detail}`);
  }
  return body.data;
}

/** How many rows one page of a list query pulls (hub hard-caps at 1000). */
export const PAGE_SIZE = 100;

/** Common interface implemented by every live-data adapter. */
export interface ProposalFetcher {
  /** Which GovernanceSource the fetched proposals are tagged with. */
  readonly source: GovernanceSource;
  /** Newest-first proposal list for one DAO (`space` id, governor address…). */
  listProposals(
    dao: string,
    opts?: { limit?: number; chainIds?: number[] },
  ): Promise<Proposal[]>;
  /** Ballots for one proposal, newest first. */
  listVotes(
    proposalId: string,
    opts?: { limit?: number; governorId?: string },
  ): Promise<Vote[]>;
}

/**
 * Page through a cursor/skip-paginated list query until `limit` rows are
 * collected or a short page is returned.
 */
export async function fetchAllPages<T>(
  limit: number,
  fetchPage: (skip: number, first: number) => Promise<T[]>,
): Promise<T[]> {
  const rows: T[] = [];
  let skip = 0;
  while (rows.length < limit) {
    const page = await fetchPage(skip, Math.min(PAGE_SIZE, limit - skip));
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    skip += page.length;
  }
  return rows.slice(0, limit);
}
