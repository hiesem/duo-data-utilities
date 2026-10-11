import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createClient, SDK_USER_AGENT, SDK_VERSION } from "../src/index.js";
import { challengeHeader, envelope, jsonResponse, paymentResponseHeader } from "./helpers/challenge.js";
import { startMockServer, type MockReply } from "./helpers/mock-server.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const EXPECTED = `duo-data-utilities-js/${pkg.version} (+https://github.com/hiesem/duo-data-utilities)`;

/** A fetch that never touches the network and records the headers of each request. */
function recordingFetch() {
  const seen: Array<string | null> = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    seen.push(request.headers.get("user-agent"));
    return jsonResponse(envelope(new URL(request.url).pathname, {}));
  };
  return { seen, fetchImpl };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("User-Agent", () => {
  it("takes the version from package.json", () => {
    expect(SDK_VERSION).toBe(pkg.version);
    expect(SDK_USER_AGENT).toBe(EXPECTED);
  });

  it("is sent with every request by default", async () => {
    const { seen, fetchImpl } = recordingFetch();
    const client = createClient({ fetch: fetchImpl });
    await client.iban.validate({ iban: "NL91ABNA0417164300" });
    await client.call("/v1/code/hash", { data: "x", algo: "sha256" });
    expect(seen).toEqual([EXPECTED, EXPECTED]);
  });

  it("can be replaced or extended by the caller", async () => {
    const { seen, fetchImpl } = recordingFetch();
    await createClient({ fetch: fetchImpl, userAgent: "my-agent/2.0" }).iban.validate({ iban: "x" });
    await createClient({ fetch: fetchImpl, userAgent: `${SDK_USER_AGENT} my-agent/2.0` }).iban.validate({ iban: "x" });
    expect(seen).toEqual(["my-agent/2.0", `${EXPECTED} my-agent/2.0`]);
  });

  it("refuses a value with line breaks", () => {
    expect(() => createClient({ fetch: recordingFetch().fetchImpl, userAgent: "a\r\nX-Evil: 1" })).toThrow(TypeError);
  });

  it("is not set in a browser, and no other custom header is added", async () => {
    vi.stubGlobal("document", {});
    const headers: string[][] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      const names: string[] = [];
      request.headers.forEach((_value, name) => names.push(name));
      headers.push(names);
      return jsonResponse(envelope(new URL(request.url).pathname, {}));
    };
    await createClient({ fetch: fetchImpl }).iban.validate({ iban: "NL91ABNA0417164300" });
    expect(headers).toEqual([["accept"]]);
  });

  it("reaches the server on both the unpaid request and the paid retry", async () => {
    // A throwaway account generated at run time; the mock server is loopback only.
    const account = privateKeyToAccount(generatePrivateKey());
    const server = await startMockServer((request): MockReply =>
      request.paymentSignature === null
        ? { status: 402, headers: { "PAYMENT-REQUIRED": challengeHeader() } }
        : { status: 200, headers: { "PAYMENT-RESPONSE": paymentResponseHeader(account.address) }, body: envelope(request.path, { valid: true }) },
    );
    try {
      const client = createClient({ account, baseUrl: server.baseUrl, payTo: null });
      await client.iban.validate({ iban: "NL91ABNA0417164300" });
      expect(server.requests.map((request) => request.userAgent)).toEqual([EXPECTED, EXPECTED]);
    } finally {
      await server.close();
    }
  });
});
