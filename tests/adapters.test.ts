/**
 * Tests for src/adapters.ts: the GraphQL transport layer and pagination
 * helper, with a stubbed global fetch. No live network in tests.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AdapterError,
  fetchAllPages,
  fetchGraphql,
} from "../src/adapters.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetchOnce(payload: unknown, ok = true, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok,
      status,
      json: () => Promise.resolve(payload),
    }),
  );
}

describe("fetchGraphql", () => {
  it("returns the data payload on success", async () => {
    stubFetchOnce({ data: { proposals: [] } });
    const data = await fetchGraphql("https://x.test/gql", "{ proposals { id } }");
    expect(data).toEqual({ proposals: [] });
  });

  it("sends query + variables as a JSON POST", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: {} }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await fetchGraphql(
      "https://x.test/gql",
      "query Q($a: Int!) { x(a: $a) }",
      { a: 3 },
      { headers: { "Api-Key": "k" } },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://x.test/gql");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      "Api-Key": "k",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      query: "query Q($a: Int!) { x(a: $a) }",
      variables: { a: 3 },
    });
  });

  it("throws AdapterError on HTTP errors", async () => {
    stubFetchOnce({ message: "nope" }, false, 429);
    await expect(fetchGraphql("https://x.test/gql", "{ x }")).rejects.toThrow(
      AdapterError,
    );
  });

  it("throws AdapterError on GraphQL errors", async () => {
    stubFetchOnce({ errors: [{ message: "bad field" }] });
    await expect(fetchGraphql("https://x.test/gql", "{ x }")).rejects.toThrow(
      /bad field/,
    );
  });

  it("throws AdapterError on transport failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("dns down")));
    await expect(fetchGraphql("https://x.test/gql", "{ x }")).rejects.toThrow(
      /dns down/,
    );
  });

  it("times out slow responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      ),
    );
    await expect(
      fetchGraphql("https://x.test/gql", "{ x }", {}, { timeoutMs: 30 }),
    ).rejects.toThrow(/timed out/);
  });
});

describe("fetchAllPages", () => {
  it("collects pages until a short page", async () => {
    const calls: Array<[number, number]> = [];
    const rows = await fetchAllPages<number>(250, async (skip, first) => {
      calls.push([skip, first]);
      if (skip === 0) return Array.from({ length: 100 }, (_, i) => i);
      return Array.from({ length: 40 }, (_, i) => 100 + i);
    });
    expect(rows).toHaveLength(140);
    expect(calls[0]).toEqual([0, 100]);
    expect(calls[1]).toEqual([100, 100]);
  });

  it("caps the total at limit", async () => {
    const rows = await fetchAllPages<number>(30, async (skip, first) =>
      Array.from({ length: first }, (_, i) => skip + i),
    );
    expect(rows).toHaveLength(30);
    expect(rows[29]).toBe(29);
  });
});
