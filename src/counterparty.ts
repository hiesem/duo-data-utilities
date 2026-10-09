import { DuoApiError } from "./errors.js";
import type { GeneratedClient } from "./generated.js";

export interface CounterpartyInput {
  /** IBAN, with or without spaces. */
  iban: string;
  /** ISO 3166-1 alpha-2 country of the tax ID, e.g. "NL". "UK" is read as "GB". */
  country: string;
  /** Tax ID kind for that country, e.g. "bsn", "nif", "cf", "cpf". */
  taxIdType: string;
  /** The tax ID or national identifier. Separators are stripped by the API. */
  taxId: string;
}

export type CheckStatus = "pass" | "fail" | "review";

export interface CounterpartyCheck {
  /** Which check ran. `country_match` compares the IBAN country with the tax ID country. */
  check: "iban" | "tax_id" | "country" | "country_match";
  /** Route that was called, or null for `country_match`. */
  route: string | null;
  status: CheckStatus;
  detail: string;
}

export interface CounterpartyResult {
  /** `fail` if any check failed, else `review` if any check could not run or the countries differ, else `pass`. */
  verdict: CheckStatus;
  checks: CounterpartyCheck[];
  /** The detail of every check that did not pass. Empty when the verdict is `pass`. */
  reasons: string[];
}

// Input problems mean the caller's data is wrong, so the check fails. Unsupported values mean the
// API cannot check this country or kind, so the check goes to review. Other errors are rethrown.
const INPUT_PROBLEM_CODES = new Set(["MISSING_PARAM", "INVALID_PARAM", "INPUT_TOO_LARGE"]);
const NOT_COVERED_CODES = new Set(["UNSUPPORTED_VALUE"]);

type Outcome<T> = { data: T } | { problem: DuoApiError };

async function outcome<T>(run: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { data: await run() };
  } catch (error) {
    if (error instanceof DuoApiError && (INPUT_PROBLEM_CODES.has(error.code) || NOT_COVERED_CODES.has(error.code))) {
      return { problem: error };
    }
    throw error;
  }
}

function problemCheck(
  check: CounterpartyCheck["check"],
  route: string,
  problem: DuoApiError,
): CounterpartyCheck {
  const status: CheckStatus = NOT_COVERED_CODES.has(problem.code) ? "review" : "fail";
  return { check, route, status, detail: `${problem.message} (${problem.code})` };
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
  return value.trim();
}

function requireCountry(value: unknown): string {
  const code = requireText(value, "country").toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) throw new TypeError("country must be an ISO 3166-1 alpha-2 code, e.g. NL");
  return code === "UK" ? "GB" : code;
}

/**
 * Checks an IBAN, a tax ID and a country code, then combines the results into one verdict.
 * Costs $0.15 (three calls). Inputs are validated before any call is made.
 * Structure and checksum only: nothing is looked up in a registry.
 */
export async function checkCounterparty(api: GeneratedClient, input: CounterpartyInput): Promise<CounterpartyResult> {
  const iban = requireText(input.iban, "iban");
  const country = requireCountry(input.country);
  const taxIdType = requireText(input.taxIdType, "taxIdType");
  const taxId = requireText(input.taxId, "taxId");
  const checks: CounterpartyCheck[] = [];

  const ibanRoute = "/v1/id/iban";
  const ibanResult = await outcome(() => api.iban.validate({ iban }));
  let ibanCountry: string | null = null;
  if ("problem" in ibanResult) {
    checks.push(problemCheck("iban", ibanRoute, ibanResult.problem));
  } else if (ibanResult.data.valid) {
    ibanCountry = ibanResult.data.country.toUpperCase();
    checks.push({ check: "iban", route: ibanRoute, status: "pass", detail: `IBAN checksum valid (${ibanCountry})` });
  } else {
    const reason = ibanResult.data.reason ?? "unknown reason";
    checks.push({ check: "iban", route: ibanRoute, status: "fail", detail: `IBAN invalid: ${reason}` });
  }

  const taxRoute = "/v1/id/national";
  const taxResult = await outcome(() => api.taxId.validate({ country, kind: taxIdType, value: taxId }));
  if ("problem" in taxResult) {
    checks.push(problemCheck("tax_id", taxRoute, taxResult.problem));
  } else if (taxResult.data.valid) {
    checks.push({ check: "tax_id", route: taxRoute, status: "pass", detail: `${taxIdType} checksum valid for ${country}` });
  } else {
    const reason = taxResult.data.reason ?? "unknown reason";
    checks.push({ check: "tax_id", route: taxRoute, status: "fail", detail: `${taxIdType} invalid for ${country}: ${reason}` });
  }

  const countryRoute = "/v1/ref/country";
  const countryResult = await outcome(() => api.country.lookup({ code: country }));
  if ("problem" in countryResult) {
    checks.push(problemCheck("country", countryRoute, countryResult.problem));
  } else if (countryResult.data.found && countryResult.data.kind === "country") {
    checks.push({ check: "country", route: countryRoute, status: "pass", detail: `${country} is an ISO 3166-1 country` });
  } else {
    checks.push({ check: "country", route: countryRoute, status: "fail", detail: `${country} is not an ISO 3166-1 country code` });
  }

  if (ibanCountry !== null && ibanCountry !== country) {
    checks.push({
      check: "country_match",
      route: null,
      status: "review",
      detail: `IBAN country ${ibanCountry} differs from the tax ID country ${country}`,
    });
  }

  const statuses = checks.map((check) => check.status);
  const verdict: CheckStatus = statuses.includes("fail") ? "fail" : statuses.includes("review") ? "review" : "pass";
  const reasons = checks.filter((check) => check.status !== "pass").map((check) => check.detail);
  return { verdict, checks, reasons };
}
