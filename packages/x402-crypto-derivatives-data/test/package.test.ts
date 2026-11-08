// The standalone package exposes the derivs client on its own. Mocked fetch only: nothing is paid.
import { describe, expect, it } from "vitest";
import { createClient, createDerivsClient, DERIVS_ROUTES, SDK_USER_AGENT, SDK_VERSION } from "../src/index.js";

describe("x402-crypto-derivatives-data", () => {
  it("lists 10 routes and names itself in the User-Agent", () => {
    expect(DERIVS_ROUTES).toHaveLength(10);
    expect(createClient).toBe(createDerivsClient);
    expect(SDK_VERSION).toBe("0.3.0");
    expect(SDK_USER_AGENT).toBe("x402-crypto-derivatives-data-js/0.3.0 (+https://github.com/hiesem/duo-data-utilities)");
  });

  it("every route method GETs https://derivs.duoleads.com", async () => {
    const seen: Array<[string, string]> = [];
    const client = createClient({
      fetch: async (input, init) => {
        const url = new URL(String(input));
        seen.push([url.origin + url.pathname, init?.method ?? "GET"]);
        return new Response("{}", { status: 200 });
      },
    }) as unknown as Record<string, (p: object) => Promise<unknown>>;
    for (const r of DERIVS_ROUTES) await client[r.method]?.({ coin: "BTC" });
    expect(seen).toEqual(DERIVS_ROUTES.map((r) => [`https://derivs.duoleads.com${r.path}`, "GET"]));
  });
});
