// Cost: $0.05 per call (x402, USDC on Base). Each tool call the model makes pays once. checkCounterparty costs $0.15.
// Needs DUO_PAYER_KEY: a 0x-prefixed private key for a wallet that holds a little USDC on Base. Never paste a key here.
// Written for the Vercel AI SDK v5 tool() API (inputSchema). Install: npm install ai zod duo-data-utilities viem
// Not compiled or run in this repository. Not run in CI.
import { tool } from "ai";
import { z } from "zod";
import { privateKeyToAccount } from "viem/accounts";
import { createClient } from "duo-data-utilities";

const key = process.env.DUO_PAYER_KEY;
if (!key?.startsWith("0x")) throw new Error("set DUO_PAYER_KEY to a 0x-prefixed private key");

// The price guard refuses any price above $0.05 per call before it signs.
const client = createClient({ account: privateKeyToAccount(key as `0x${string}`) });

export const duoTools = {
  validateIban: tool({
    description: "Check an IBAN: length, mod-97 check digits, and the bank, branch and account breakdown. Costs $0.05.",
    inputSchema: z.object({ iban: z.string().describe("The IBAN, with or without spaces") }),
    execute: async ({ iban }) => client.iban.validate({ iban }),
  }),
  checkCounterparty: tool({
    description: "Check an IBAN, a tax ID and a country together. Structure and checksum only. Costs $0.15.",
    inputSchema: z.object({
      iban: z.string(),
      country: z.string().describe("ISO 3166-1 alpha-2 code, e.g. NL"),
      taxIdType: z.string().describe("Tax ID kind for that country, e.g. bsn, nif, cf, cpf"),
      taxId: z.string(),
    }),
    execute: async (input) => {
      const result = await client.checkCounterparty(input);
      return { verdict: result.verdict, reasons: result.reasons };
    },
  }),
};
