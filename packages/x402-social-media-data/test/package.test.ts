// The standalone package exposes the social client on its own. Mocked fetch only: nothing is paid.
import { describe, expect, it } from "vitest";
import { createClient, createSocialClient, SDK_USER_AGENT, SDK_VERSION, SOCIAL_ROUTES } from "../src/index.js";

describe("x402-social-media-data", () => {
  it("lists 26 routes and names itself in the User-Agent", () => {
    expect(SOCIAL_ROUTES).toHaveLength(26);
    expect(createClient).toBe(createSocialClient);
    expect(SDK_VERSION).toBe("0.3.2");
    expect(SDK_USER_AGENT).toBe("x402-social-media-data-js/0.3.2 (+https://github.com/hiesem/duo-data-utilities)");
  });

  it("every route method GETs https://social.duoleads.com", async () => {
    const seen: Array<[string, string]> = [];
    const client = createClient({
      fetch: async (input, init) => {
        const url = new URL(String(input));
        seen.push([url.origin + url.pathname, init?.method ?? "GET"]);
        return new Response("{}", { status: 200 });
      },
    }) as unknown as Record<string, (p: object) => Promise<unknown>>;
    for (const r of SOCIAL_ROUTES) await client[r.method]?.({ q: "x", handle: "nasa" });
    expect(seen).toEqual(SOCIAL_ROUTES.map((r) => [`https://social.duoleads.com${r.path}`, "GET"]));
  });
});
