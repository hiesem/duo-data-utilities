import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createClient, DuoApiError, ROUTES } from "../src/index.js";
import { buildQuery } from "../src/caller.js";
import { envelope, jsonResponse, paymentResponseHeader } from "./helpers/challenge.js";

type Recorded = { url: URL; init: RequestInit | undefined };

/** A fetch that never touches the network. It records each call and answers with `reply`. */
function fakeFetch(reply: (url: URL) => Response | Promise<Response> = (url) => jsonResponse(envelope(url.pathname, {}))) {
  const calls: Recorded[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return reply(url);
  };
  return { calls, fetchImpl };
}

const manifest = JSON.parse(readFileSync(new URL("../spec/manifest.json", import.meta.url), "utf8")) as {
  data: { routes: Array<{ path: string; example: Record<string, unknown> }> };
};

describe("createClient options", () => {
  it("needs exactly one of account or fetch", () => {
    expect(() => createClient()).toThrow(TypeError);
    expect(() => createClient({ fetch: fakeFetch().fetchImpl, account: undefined })).not.toThrow();
    expect(() => createClient({ fetch: fakeFetch().fetchImpl, account: {} as never })).toThrow(TypeError);
  });

  it("accepts https and localhost only", () => {
    const { fetchImpl } = fakeFetch();
    expect(() => createClient({ fetch: fetchImpl, baseUrl: "http://api.example.com" })).toThrow(/must use https/);
    expect(() => createClient({ fetch: fetchImpl, baseUrl: "https://api.example.com/?x=1" })).toThrow(/query or a fragment/);
    expect(() => createClient({ fetch: fetchImpl, baseUrl: "http://localhost:8787" })).not.toThrow();
    expect(() => createClient({ fetch: fetchImpl, baseUrl: "http://127.0.0.1:8787" })).not.toThrow();
  });

  it("rejects a maxPriceUsd that is not a positive amount", () => {
    expect(() => createClient({ fetch: fakeFetch().fetchImpl, maxPriceUsd: 0 })).toThrow(RangeError);
  });
});

describe("custom fetch", () => {
  it("uses the default origin and sends the query string", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const client = createClient({ fetch: fetchImpl });
    await client.iban.validate({ iban: "NL91ABNA0417164300" });
    expect(calls[0]?.url.href).toBe("https://api.duoleads.com/v1/id/iban?iban=NL91ABNA0417164300");
    expect(calls[0]?.init?.method).toBe("GET");
  });

  it("resolves to the envelope's data and returns the receipt when present", async () => {
    const { fetchImpl } = fakeFetch((url) =>
      jsonResponse(envelope(url.pathname, { valid: true }), {
        headers: { "PAYMENT-RESPONSE": paymentResponseHeader("0x0000000000000000000000000000000000000001") },
      }),
    );
    const result = await createClient({ fetch: fetchImpl }).callWithReceipt("/v1/id/iban", { iban: "NL91ABNA0417164300" });
    expect(result.data).toEqual({ valid: true });
    expect(result.receipt).toMatchObject({ success: true, network: "eip155:8453" });
  });

  it("returns a null receipt when the response has no PAYMENT-RESPONSE header", async () => {
    const { fetchImpl } = fakeFetch();
    const result = await createClient({ fetch: fetchImpl }).callWithReceipt("/v1/code/jwt", { token: "a.b.c" });
    expect(result.receipt).toBeNull();
    expect(result.meta).toMatchObject({ price_usd: "0.05" });
  });

  it("throws DuoApiError with code, param, message and expected from an error envelope", async () => {
    const { fetchImpl } = fakeFetch(() =>
      jsonResponse(
        {
          ok: false,
          route: "/v1/id/national",
          version: "1.0.0",
          error: { code: "UNSUPPORTED_VALUE", param: "kind", message: "kind xyz is not supported for NL", expected: "bsn" },
          meta: { request_id: "01ERRORREQUEST0000000000", computed_at: "2026-10-09T00:00:00.000Z", disclaimer: "x" },
        },
        { status: 400 },
      ),
    );
    const error = await createClient({ fetch: fetchImpl })
      .taxId.validate({ country: "NL", kind: "xyz", value: "1" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DuoApiError);
    expect(error).toMatchObject({
      name: "DuoApiError",
      code: "UNSUPPORTED_VALUE",
      param: "kind",
      message: "kind xyz is not supported for NL",
      expected: "bsn",
      status: 400,
      route: "/v1/id/national",
      requestId: "01ERRORREQUEST0000000000",
    });
  });

  it("reports INVALID_RESPONSE for a 200 that is not an envelope", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("<html>ok</html>", { status: 200 }));
    await expect(createClient({ fetch: fetchImpl }).call("/v1/id/iban", { iban: "x" })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("reports PAYMENT_REQUIRED for a 402 that is returned after a payment attempt", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("", { status: 402 }));
    await expect(createClient({ fetch: fetchImpl }).call("/v1/id/iban", { iban: "x" })).rejects.toMatchObject({
      code: "PAYMENT_REQUIRED",
      status: 402,
    });
  });

  it("reports HTTP_<status> for a non-envelope error", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("gateway down", { status: 502 }));
    await expect(createClient({ fetch: fetchImpl }).call("/v1/id/iban", { iban: "x" })).rejects.toMatchObject({ code: "HTTP_502" });
  });

  it("refuses anything that is not a route path, before any request", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const client = createClient({ fetch: fetchImpl });
    await expect(client.call("/v1/../mcp")).rejects.toThrow(TypeError);
    await expect(client.call("https://evil.example/v1/id/iban")).rejects.toThrow(TypeError);
    await expect(client.call("/healthz")).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });
});

describe("generated methods", () => {
  it("cover all 33 routes and map each to its path and example parameters", async () => {
    expect(ROUTES).toHaveLength(33);
    const { calls, fetchImpl } = fakeFetch();
    const client = createClient({ fetch: fetchImpl }) as unknown as Record<string, Record<string, (p: object) => Promise<unknown>>>;
    for (const route of ROUTES) {
      const example = manifest.data.routes.find((r) => r.path === route.path)?.example;
      expect(example, route.path).toBeDefined();
      const method = client[route.namespace]?.[route.method];
      expect(method, `${route.namespace}.${route.method}`).toBeTypeOf("function");
      await method?.(example ?? {});
      const last = calls.at(-1);
      expect(last?.url.pathname).toBe(route.path);
      expect(Object.fromEntries(last?.url.searchParams ?? [])).toEqual(
        Object.fromEntries(Object.entries(example ?? {}).map(([k, v]) => [k, String(v)])),
      );
    }
    expect(calls).toHaveLength(33);
  });

  it("types booleans and numbers as the API expects on the query string", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const client = createClient({ fetch: fetchImpl });
    await client.punycode.convert({ domain: "bücher.example", strict: false });
    await client.distance.calculate({ op: "distance", lat1: 52.3728, lon1: 4.8936, lat2: 40.7128, lon2: -74.006 });
    expect(calls[0]?.url.searchParams.get("strict")).toBe("false");
    expect(calls[1]?.url.searchParams.get("lat1")).toBe("52.3728");
  });

  it("keeps the call escape hatch for any route", async () => {
    const { calls, fetchImpl } = fakeFetch();
    await createClient({ fetch: fetchImpl }).call("/v1/code/hash", { data: "abc", algo: "sha256" });
    expect(calls[0]?.url.pathname).toBe("/v1/code/hash");
    expect(calls[0]?.url.searchParams.get("algo")).toBe("sha256");
  });
});

describe("buildQuery", () => {
  it("drops null and undefined, and writes booleans and numbers as text", () => {
    expect(buildQuery({ a: true, b: 3, c: undefined, d: null, e: "x y" })).toBe("a=true&b=3&e=x+y");
  });

  it("refuses nested values", () => {
    expect(() => buildQuery({ list: [1, 2] })).toThrow(TypeError);
  });
});
