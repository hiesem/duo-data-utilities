// Cost: $0.05 per call, paid in USDC on Base via x402. This example makes 6 paid calls: $0.30 (three calls for the counterparty check, the rest one call each).
// Needs DUO_PAYER_KEY, a 0x-prefixed private key of a wallet that holds a little USDC on Base.
// Never paste a key into this file. Run with: DUO_PAYER_KEY=0x... npx tsx examples/node-basic.ts
// Not run in CI.
import { privateKeyToAccount } from "viem/accounts";
import { createClient } from "duo-data-utilities";

const key = process.env.DUO_PAYER_KEY;
if (!key?.startsWith("0x")) throw new Error("set DUO_PAYER_KEY to a 0x-prefixed private key");

// Refuses any price above $0.05 per call before it signs.
const client = createClient({ account: privateKeyToAccount(key as `0x${string}`) });

const iban = await client.iban.validate({ iban: "NL91 ABNA 0417 1643 00" });
console.log("IBAN valid:", iban.valid, iban.country);

const zone = await client.timezone.convert({ zone: "Europe/Amsterdam", instant: "2026-07-01T12:00:00Z" });
console.log("Local time:", JSON.stringify(zone));

// Three calls, $0.15. Structure and checksum only: nothing is looked up in a registry.
const verdict = await client.checkCounterparty({
  iban: "NL91 ABNA 0417 1643 00",
  country: "NL",
  taxIdType: "bsn",
  taxId: "111222333",
});
console.log("Counterparty verdict:", verdict.verdict, verdict.reasons);

// The receipt of the last paid call, from the PAYMENT-RESPONSE header.
const paid = await client.callWithReceipt("/v1/code/hash", { data: "hello", algo: "sha256" });
console.log("Transaction:", paid.receipt?.transaction ?? "(no receipt)");
