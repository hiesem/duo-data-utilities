// The standalone package exposes the keyword client on its own. Mocked fetch only: nothing is paid.
import { describe, expect, it } from "vitest";
import { createClient, createKeywordsClient, KEYWORDS_ROUTES, SDK_USER_AGENT, SDK_VERSION, SEO_KEYWORD_ROUTES } from "../src/index.js";

describe("x402-seo-keyword-data", () => {
  it("lists 44 routes and names itself in the User-Agent", () => {
    expect(SEO_KEYWORD_ROUTES).toHaveLength(44);
    expect(KEYWORDS_ROUTES).toHaveLength(6);
    expect(createClient).toBe(createKeywordsClient);
    expect(SDK_VERSION).toBe("0.3.2");
    expect(SDK_USER_AGENT).toBe("x402-seo-keyword-data-js/0.3.2 (+https://github.com/hiesem/duo-data-utilities)");
  });

  it("every route method calls https://keywords.duoleads.com with the route's HTTP method", async () => {
    const seen: Array<[string, string, string | undefined]> = [];
    const client = createClient({
      fetch: async (input, init) => {
        const url = new URL(String(input));
        seen.push([url.origin + url.pathname, init?.method ?? "GET", (init?.headers as Record<string, string>)["user-agent"]]);
        return new Response("{}", { status: 200 });
      },
    }) as unknown as Record<string, (p: object) => Promise<unknown>>;
    for (const r of SEO_KEYWORD_ROUTES) await client[r.method]?.({ keyword: "x", keywords: ["x"], target: "example.com", q: "x" });
    expect(seen).toEqual(SEO_KEYWORD_ROUTES.map((r) => [`https://keywords.duoleads.com${r.path}`, r.httpMethod, SDK_USER_AGENT]));
  });
});
