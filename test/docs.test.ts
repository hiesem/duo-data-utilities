import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Newest mcp-remote release at least 14 days old with no advisory (0.15.2, 2026-10-20; checked 2026-11-09 with
// `npm view mcp-remote time --json` and the GitHub advisory database). Update deliberately.
const MCP_REMOTE_VERSION = "0.15.2";
const read = (relative: string): string => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
const keywords = JSON.parse(read("spec/keywords.json")).routes as Record<string, { tool: string; summary: string }>;
const methods = JSON.parse(read("spec/methods.json")).routes as Record<string, { namespace: string; method: string }>;

describe("README", () => {
  const readme = read("README.md");

  it("opens with the keyword-first line", () => {
    expect(readme.split("\n")[0]).toBe(
      "IBAN, ISIN, VAT/tax ID and GTIN barcode validation plus 29 more utilities for AI agents. Pay per call ($0.05 USDC on Base via x402), no API key, no signup.",
    );
  });

  it("has one table row per route, naming the method and the route", () => {
    expect(Object.keys(methods)).toHaveLength(33);
    for (const [path, method] of Object.entries(methods)) {
      expect(readme).toContain(`| \`${method.namespace}.${method.method}\` | \`${path}\` |`);
    }
    expect(readme.split("\n").filter((line) => /^\| `[a-zA-Z]+\.[a-zA-Z]+` \| `\/v1\/[a-z]+\/[a-z0-9-]+` \|/.test(line))).toHaveLength(33);
  });

  it("describes VAT and tax ID checks with the agreed wording", () => {
    expect(readme).toContain("VAT, tax ID and national ID validator: 23 countries, checksum only (VAT formats BE, DE, FR, IT, PL, AT, CH, IE)");
  });

  it("never mentions LEI (not supported by the API)", () => {
    expect(readme).not.toMatch(/\bLEI\b/);
    expect(readme.toLowerCase()).not.toContain("legal entity identifier");
  });

  it("links the public pages", () => {
    for (const url of ["https://api.duoleads.com/docs", "https://api.duoleads.com/openapi.json", "https://api.duoleads.com/llms.txt", "https://api.duoleads.com/terms", "https://api.duoleads.com/privacy"]) {
      expect(readme).toContain(url);
    }
  });
});

describe("README: derivs", () => {
  const readme = read("README.md");
  const derivs = JSON.parse(read("spec/derivs.json")).routes as Array<{ path: string; tool: string; amount: string }>;
  const derivsMethods = JSON.parse(read("spec/derivs-methods.json")).routes as Record<string, { method: string }>;
  const snake = (name: string) => name.replace(/(?<!^)(?=[A-Z])/g, "_").toLowerCase();

  it("has a keyword-first derivatives section", () => {
    expect(readme).toContain(
      "## Crypto derivatives data: perp funding rates, open interest, futures basis, implied volatility, liquidations, order book depth",
    );
  });

  it("has one row per derivs route with both method names, the route and the price", () => {
    for (const route of derivs) {
      const method = derivsMethods[route.path]?.method ?? "";
      const price = route.amount === "5000" ? "$0.005" : "$0.003";
      expect(readme, route.path).toContain(`| \`derivs.${method}\` | \`derivs.${snake(method)}\` | \`${route.path}\` | ${price} |`);
    }
  });

  it("links the derivs pages and the MCP endpoint", () => {
    for (const url of ["https://derivs.duoleads.com/docs", "https://derivs.duoleads.com/openapi.json", "https://derivs.duoleads.com/terms", "https://derivs.duoleads.com/privacy", "https://derivs.duoleads.com/mcp"]) {
      expect(readme).toContain(url);
    }
  });
});

describe("MCP configuration", () => {
  const mcpReadme = read("mcp/README.md");

  it("lists all 33 tool names from the inventory", () => {
    for (const [path, route] of Object.entries(keywords)) {
      expect(mcpReadme, path).toContain(`| \`${route.tool}\` | \`${path}\` |`);
    }
  });

  it("lists the 10 derivs tools with route and price, and has a config per client", () => {
    const derivs = JSON.parse(read("spec/derivs.json")).routes as Array<{ path: string; tool: string; amount: string }>;
    for (const route of derivs) {
      expect(mcpReadme, route.path).toContain(`| \`${route.tool}\` | \`${route.path}\` | ${route.amount === "5000" ? "$0.005" : "$0.003"} |`);
    }
    for (const file of ["derivs.mcp.json", "derivs.claude-desktop.json", "derivs.cursor.mcp.json", "derivs.vscode.mcp.json"]) {
      expect(read(`mcp/${file}`), file).toContain("https://derivs.duoleads.com/mcp");
    }
  });

  it("parses every JSON file under mcp/", () => {
    const files = readdirSync(new URL("../mcp/", import.meta.url)).filter((name) => name.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(() => JSON.parse(read(`mcp/${file}`)), file).not.toThrow();
  });

  it("pins the mcp-remote bridge to an exact version in every config and README block (R64-PA-06)", () => {
    const configs = readdirSync(new URL("../mcp/", import.meta.url)).filter((name) => name.endsWith(".json"));
    const texts = [...configs.map((file) => [file, read(`mcp/${file}`)]), ["mcp/README.md", mcpReadme], ["README.md", read("README.md")]];
    let pinned = 0;
    for (const [file, text] of texts) {
      for (const match of text!.matchAll(/"mcp-remote(@[^"]*)?"/g)) {
        expect(match[1], file).toBe(`@${MCP_REMOTE_VERSION}`);
        pinned++;
      }
    }
    expect(pinned).toBeGreaterThanOrEqual(2);
  });

  it("parses every fenced json block in mcp/README.md", () => {
    const blocks = [...mcpReadme.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
    for (const block of blocks) expect(() => JSON.parse(block)).not.toThrow();
  });
});

describe("package metadata", () => {
  const pkg = JSON.parse(read("package.json"));

  it("publishes only dist, the README and the licence", () => {
    expect(pkg.files).toEqual(["dist", "README.md", "LICENSE"]);
  });

  it("names the organisation as author, with no personal address", () => {
    expect(pkg.author).toBe("Duo Data Utilities");
    // Patterns are assembled from fragments so this file does not contain the personal strings itself.
    const personal = [new RegExp("@" + "gmail"), new RegExp("killer" + "his")];
    for (const pattern of personal) expect(JSON.stringify(pkg)).not.toMatch(pattern);
  });

  it("uses the MIT licence and the agreed package name and version", () => {
    expect(pkg.license).toBe("MIT");
    expect(pkg.name).toBe("duo-data-utilities");
    expect(pkg.version).toBe("0.3.0");
  });
});
