import { describe, expect, it } from "vitest";
import { createClient, DuoApiError } from "../src/index.js";
import { envelope, jsonResponse } from "./helpers/challenge.js";

type Answer = { data: Record<string, unknown> } | { error: { code: string; message: string; param?: string; expected?: string } };

// Answers each route from a table and records the calls. No payment is involved.
function routeFetch(answers: Record<string, Answer>) {
  const calls: string[] = [];
  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}?${url.searchParams.toString()}`);
    const answer = answers[url.pathname];
    if (!answer) throw new Error(`no answer for ${url.pathname}`);
    if ("error" in answer) {
      return jsonResponse(
        {
          ok: false,
          route: url.pathname,
          version: "1.0.0",
          error: { param: null, expected: null, ...answer.error },
          meta: { request_id: "01COUNTERPARTY0000000000", computed_at: "2026-10-09T00:00:00.000Z", disclaimer: "x" },
        },
        { status: 400 },
      );
    }
    return jsonResponse(envelope(url.pathname, answer.data));
  };
  return { calls, fetchImpl };
}

const IBAN_OK: Answer = { data: { valid: true, country: "NL", reason: null } };
const TAX_OK: Answer = { data: { valid: true, country: "NL", kind: "bsn", reason: null } };
const COUNTRY_OK: Answer = { data: { found: true, kind: "country", alpha_2: "NL" } };

const input = { iban: "NL91 ABNA 0417 1643 00", country: "NL", taxIdType: "bsn", taxId: "111222333" };

describe("checkCounterparty verdicts", () => {
  it("passes when every check passes, using three calls", async () => {
    const { calls, fetchImpl } = routeFetch({ "/v1/id/iban": IBAN_OK, "/v1/id/national": TAX_OK, "/v1/ref/country": COUNTRY_OK });
    const result = await createClient({ fetch: fetchImpl }).checkCounterparty(input);
    expect(result.verdict).toBe("pass");
    expect(result.reasons).toEqual([]);
    expect(result.checks.map((c) => [c.check, c.route, c.status])).toEqual([
      ["iban", "/v1/id/iban", "pass"],
      ["tax_id", "/v1/id/national", "pass"],
      ["country", "/v1/ref/country", "pass"],
    ]);
    expect(calls).toEqual([
      "/v1/id/iban?iban=NL91+ABNA+0417+1643+00",
      "/v1/id/national?country=NL&kind=bsn&value=111222333",
      "/v1/ref/country?code=NL",
    ]);
  });

  it("fails when the IBAN is invalid, and still checks the rest", async () => {
    const { calls, fetchImpl } = routeFetch({
      "/v1/id/iban": { data: { valid: false, country: "NL", reason: "checksum" } },
      "/v1/id/national": TAX_OK,
      "/v1/ref/country": COUNTRY_OK,
    });
    const result = await createClient({ fetch: fetchImpl }).checkCounterparty(input);
    expect(result.verdict).toBe("fail");
    expect(result.reasons).toEqual(["IBAN invalid: checksum"]);
    expect(calls).toHaveLength(3);
  });

  it("fails when the tax ID is invalid", async () => {
    const { fetchImpl } = routeFetch({
      "/v1/id/iban": IBAN_OK,
      "/v1/id/national": { data: { valid: false, country: "NL", kind: "bsn", reason: "checksum" } },
      "/v1/ref/country": COUNTRY_OK,
    });
    const result = await createClient({ fetch: fetchImpl }).checkCounterparty(input);
    expect(result.verdict).toBe("fail");
    expect(result.reasons).toEqual(["bsn invalid for NL: checksum"]);
  });

  it("reviews when the IBAN country differs from the tax ID country", async () => {
    const { fetchImpl } = routeFetch({
      "/v1/id/iban": { data: { valid: true, country: "DE", reason: null } },
      "/v1/id/national": TAX_OK,
      "/v1/ref/country": COUNTRY_OK,
    });
    const result = await createClient({ fetch: fetchImpl }).checkCounterparty(input);
    expect(result.verdict).toBe("review");
    expect(result.checks.at(-1)).toMatchObject({ check: "country_match", route: null, status: "review" });
    expect(result.reasons).toEqual(["IBAN country DE differs from the tax ID country NL"]);
  });

  it("reads UK as GB, so a UK IBAN and a UK tax ID agree", async () => {
    const { calls, fetchImpl } = routeFetch({
      "/v1/id/iban": { data: { valid: true, country: "GB", reason: null } },
      "/v1/id/national": { data: { valid: true, country: "GB", kind: "nino", reason: null } },
      "/v1/ref/country": { data: { found: true, kind: "country", alpha_2: "GB" } },
    });
    const result = await createClient({ fetch: fetchImpl }).checkCounterparty({ ...input, country: "uk", taxIdType: "nino" });
    expect(result.verdict).toBe("pass");
    expect(calls[1]).toBe("/v1/id/national?country=GB&kind=nino&value=111222333");
  });

  it("reviews, rather than fails, when the API does not cover the country or kind", async () => {
    const { fetchImpl } = routeFetch({
      "/v1/id/iban": IBAN_OK,
      "/v1/id/national": { error: { code: "UNSUPPORTED_VALUE", message: "kind xyz is not supported for NL", param: "kind", expected: "bsn" } },
      "/v1/ref/country": COUNTRY_OK,
    });
    const result = await createClient({ fetch: fetchImpl }).checkCounterparty({ ...input, taxIdType: "xyz" });
    expect(result.verdict).toBe("review");
    expect(result.checks[1]).toMatchObject({ check: "tax_id", status: "review", detail: "kind xyz is not supported for NL (UNSUPPORTED_VALUE)" });
  });

  it("fails on an input problem reported by the API", async () => {
    const { fetchImpl } = routeFetch({
      "/v1/id/iban": { error: { code: "INVALID_PARAM", message: "iban is malformed", param: "iban" } },
      "/v1/id/national": TAX_OK,
      "/v1/ref/country": COUNTRY_OK,
    });
    const result = await createClient({ fetch: fetchImpl }).checkCounterparty(input);
    expect(result.verdict).toBe("fail");
    expect(result.checks[0]).toMatchObject({ check: "iban", status: "fail" });
  });

  it("rethrows errors that are not about the input, so no verdict is hidden", async () => {
    const { fetchImpl } = routeFetch({
      "/v1/id/iban": IBAN_OK,
      "/v1/id/national": { error: { code: "INTERNAL", message: "something broke" } },
      "/v1/ref/country": COUNTRY_OK,
    });
    await expect(createClient({ fetch: fetchImpl }).checkCounterparty(input)).rejects.toBeInstanceOf(DuoApiError);
  });

  it("fails a country code that is not an ISO 3166-1 country", async () => {
    const { fetchImpl } = routeFetch({
      "/v1/id/iban": IBAN_OK,
      "/v1/id/national": TAX_OK,
      "/v1/ref/country": { data: { found: true, kind: "subdivision", alpha_2: "NL" } },
    });
    const result = await createClient({ fetch: fetchImpl }).checkCounterparty(input);
    expect(result.checks[2]).toMatchObject({ check: "country", status: "fail" });
  });
});

describe("checkCounterparty input checks", () => {
  it.each([
    ["a three-letter country", { country: "NLD" }],
    ["an empty IBAN", { iban: "  " }],
    ["a missing tax ID type", { taxIdType: "" }],
  ])("refuses %s before making any call", async (_label, change) => {
    const { calls, fetchImpl } = routeFetch({});
    await expect(createClient({ fetch: fetchImpl }).checkCounterparty({ ...input, ...change })).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });
});
