// Supplier / vendor onboarding check agent.
//
// For every supplier record it:
//   1. builds the IBAN from bank code + account number when the record has no IBAN   (/v1/id/iban-build)
//   2. validates the IBAN: length, mod-97 check digits, bank/branch/account breakdown (/v1/id/iban)
//   3. validates the VAT number's checksum for the supplier's country                 (/v1/id/national)
//   4. compares the supplier name with the bank account holder name, when given      (/v1/text/similarity)
// and decides approve / review / reject. Structure and checksum only: no company register or bank is queried.
//
// Cost: $0.05 per call, paid in USDC on Base via x402 from YOUR wallet (DUO_PAYER_KEY).
// The sample file makes 11 paid calls: $0.55. Run with --dry-run first: it prints the plan and spends nothing.
//
//   DUO_PAYER_KEY=0x... npx tsx agent.ts suppliers.example.json
//   npx tsx agent.ts suppliers.example.json --dry-run
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { createClient, DuoApiError, SDK_USER_AGENT, type DuoClient } from "duo-data-utilities";

export interface Supplier {
  id: string;
  name: string;
  /** ISO 3166-1 alpha-2 country of the supplier, e.g. "NL". */
  country: string;
  /** IBAN, with or without spaces. Or give bank + account (or bban) and the agent builds it. */
  iban?: string;
  bank?: string;
  branch?: string;
  account?: string;
  bban?: string;
  /** VAT number. The kind is picked from the country (see VAT_KIND), or set vatKind yourself. */
  vatId?: string;
  vatKind?: string;
  /** Name on the bank account, compared with `name`. */
  accountHolder?: string;
}

export type Decision = "approve" | "review" | "reject";

export interface SupplierReport {
  id: string;
  decision: Decision;
  iban: string | null;
  findings: string[];
  paidCalls: number;
}

/** VAT number kinds per country, as /v1/id/national names them. */
export const VAT_KIND: Record<string, string> = {
  NL: "btw",
  BE: "vat",
  DE: "ustid",
  FR: "tva",
  IT: "piva",
  PL: "nip",
  AT: "uid",
  CH: "uid",
  IE: "vat",
};

const PRICE_USD = 0.05;
const NAME_MATCH_REVIEW_BELOW = 0.85; // Jaro-Winkler on case-, accent-, space- and punctuation-folded names

/** The paid calls a supplier record needs. Used for --dry-run and for the spend cap. */
export function plannedCalls(supplier: Supplier): string[] {
  const calls: string[] = [];
  if (!supplier.iban && (supplier.bban || (supplier.bank && supplier.account))) calls.push("/v1/id/iban-build");
  if (supplier.iban || calls.length > 0) calls.push("/v1/id/iban");
  if (supplier.vatId && (supplier.vatKind ?? VAT_KIND[supplier.country.toUpperCase()])) calls.push("/v1/id/national");
  if (supplier.accountHolder) calls.push("/v1/text/similarity");
  return calls;
}

const worst = (a: Decision, b: Decision): Decision => (a === "reject" || b === "reject" ? "reject" : a === "review" || b === "review" ? "review" : "approve");

/** An API error that means the input itself is wrong (reject) or not covered (review). Anything else is rethrown. */
function verdictFromError(error: unknown, what: string): { decision: Decision; finding: string } {
  if (!(error instanceof DuoApiError)) throw error;
  if (error.code === "UNSUPPORTED_VALUE") return { decision: "review", finding: `${what}: not covered (${error.message})` };
  if (error.status >= 400 && error.status < 500 && error.code !== "PAYMENT_REQUIRED") {
    return { decision: "reject", finding: `${what}: ${error.message}${error.expected ? ` (expected ${error.expected})` : ""}` };
  }
  throw error;
}

export async function checkSupplier(client: DuoClient, supplier: Supplier): Promise<SupplierReport> {
  const country = supplier.country.toUpperCase();
  const findings: string[] = [];
  let decision: Decision = "approve";
  let paidCalls = 0;
  let iban = supplier.iban ?? null;

  if (!iban && (supplier.bban || (supplier.bank && supplier.account))) {
    try {
      paidCalls++;
      const built = await client.iban.generate({ country, bban: supplier.bban, bank: supplier.bank, branch: supplier.branch, account: supplier.account });
      iban = built.iban;
      findings.push(`IBAN built from bank details: ${built.iban_print}`);
    } catch (error) {
      const v = verdictFromError(error, "IBAN build");
      decision = worst(decision, v.decision);
      findings.push(v.finding);
    }
  }

  if (iban) {
    try {
      paidCalls++;
      const result = await client.iban.validate({ iban });
      iban = result.iban;
      if (!result.valid) {
        decision = "reject";
        findings.push(`IBAN invalid (${result.reason ?? "unknown reason"})`);
      } else if (result.country !== country) {
        decision = worst(decision, "review");
        findings.push(`IBAN country ${result.country} differs from supplier country ${country}`);
      } else {
        findings.push(`IBAN valid, bank code ${result.parts.bank ?? "n/a"}`);
      }
    } catch (error) {
      const v = verdictFromError(error, "IBAN");
      decision = worst(decision, v.decision);
      findings.push(v.finding);
    }
  } else {
    decision = worst(decision, "review");
    findings.push("no IBAN and no bank details");
  }

  if (supplier.vatId) {
    const kind = supplier.vatKind ?? VAT_KIND[country];
    if (!kind) {
      decision = worst(decision, "review");
      findings.push(`no VAT kind known for ${country}; set vatKind`);
    } else {
      try {
        paidCalls++;
        const vat = await client.taxId.validate({ country, kind, value: supplier.vatId });
        if (vat.valid) findings.push(`VAT number checksum valid (${vat.algorithm})`);
        else {
          decision = "reject";
          findings.push(`VAT number invalid (${vat.reason ?? "unknown reason"})`);
        }
      } catch (error) {
        const v = verdictFromError(error, "VAT number");
        decision = worst(decision, v.decision);
        findings.push(v.finding);
      }
    }
  } else {
    decision = worst(decision, "review");
    findings.push("no VAT number");
  }

  if (supplier.accountHolder) {
    paidCalls++;
    const sim = await client.text.similarity({ a: supplier.name, b: supplier.accountHolder, fold: "case,accents,space,punct", only: "jaro_winkler" });
    const score = sim.jaro_winkler ?? 0;
    if (score < NAME_MATCH_REVIEW_BELOW) {
      decision = worst(decision, "review");
      findings.push(`account holder "${supplier.accountHolder}" does not match supplier name (Jaro-Winkler ${score.toFixed(2)})`);
    } else {
      findings.push(`account holder matches supplier name (Jaro-Winkler ${score.toFixed(2)})`);
    }
  }

  return { id: supplier.id, decision, iban, findings, paidCalls };
}

async function main(): Promise<void> {
  const [file = "suppliers.example.json", ...flags] = process.argv.slice(2);
  const suppliers = JSON.parse(readFileSync(file, "utf8")) as Supplier[];
  const plan = suppliers.map((supplier) => ({ id: supplier.id, calls: plannedCalls(supplier) }));
  const totalCalls = plan.reduce((sum, entry) => sum + entry.calls.length, 0);
  const maxSpendUsd = Number(process.env.DUO_MAX_SPEND_USD ?? "1.00");

  if (flags.includes("--dry-run")) {
    for (const entry of plan) console.log(`${entry.id}: ${entry.calls.join(", ") || "(no calls)"}`);
    console.log(`\n${totalCalls} paid calls, $${(totalCalls * PRICE_USD).toFixed(2)} in USDC on Base. Nothing was sent.`);
    return;
  }
  if (totalCalls * PRICE_USD > maxSpendUsd + 1e-9) {
    throw new Error(`this run needs $${(totalCalls * PRICE_USD).toFixed(2)}, above DUO_MAX_SPEND_USD=$${maxSpendUsd.toFixed(2)}`);
  }

  const key = process.env.DUO_PAYER_KEY;
  if (!key?.startsWith("0x")) throw new Error("set DUO_PAYER_KEY to the 0x-prefixed private key of a Base wallet holding a little USDC");
  // The client refuses to sign more than $0.05 per call, or for any payee other than the service.
  const client = createClient({
    account: privateKeyToAccount(key as `0x${string}`),
    userAgent: `${SDK_USER_AGENT} supplier-onboarding-agent/1.0`,
  });

  const reports: SupplierReport[] = [];
  for (const supplier of suppliers) reports.push(await checkSupplier(client, supplier));
  console.log(JSON.stringify(reports, null, 2));
  const spent = reports.reduce((sum, report) => sum + report.paidCalls, 0) * PRICE_USD;
  console.error(`Done: ${reports.length} suppliers, $${spent.toFixed(2)} spent.`);
}

// Run only when executed directly, so tests can import checkSupplier.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
