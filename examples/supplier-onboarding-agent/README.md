# Supplier onboarding agent: IBAN validation, IBAN generation and VAT number check (TypeScript)

A vendor / supplier onboarding check for accounts payable, written in TypeScript with [duo-data-utilities](../../README.md). Before a new supplier gets its first payout, the agent checks every record in a JSON file:

1. **Builds the IBAN** from bank code and account number when the record has no IBAN (`/v1/id/iban-build`).
2. **Validates the IBAN**: length for its country, mod-97 check digits, bank/branch/account breakdown (`/v1/id/iban`). It also flags an IBAN whose country differs from the supplier's country.
3. **Validates the VAT number** checksum for the supplier's country: NL btw, BE vat, DE USt-IdNr (`ustid`), FR TVA, IT partita IVA, PL NIP, AT/CH UID, IE VAT (`/v1/id/national`).
4. **Compares the supplier name with the bank account holder name** using Jaro-Winkler similarity on folded names (`/v1/text/similarity`).

Each supplier ends as `approve`, `review` or `reject`, with the findings. Structure and checksum only: the agent does not query a company register, a bank or a tax authority, and it does not confirm that an account exists.

## Cost

Each API call costs **$0.05 in USDC on Base**, paid per request with x402 v2. There is no API key and no signup: your wallet pays. The sample file makes 11 calls, so **$0.55**. `--dry-run` prints the plan and the cost and sends nothing. The run stops before it starts if the plan costs more than `DUO_MAX_SPEND_USD` (default `1.00`). The SDK refuses to sign more than $0.05 for one call, or a payment to any address other than the service's.

## Setup

```sh
cd examples/supplier-onboarding-agent
npm install
```

| Variable | Required | What it is |
|---|---|---|
| `DUO_PAYER_KEY` | yes, except for `--dry-run` | 0x-prefixed private key of a Base wallet you control that holds a little USDC (a dollar covers 20 calls). Use a dedicated low-balance wallet. Keep it in the environment, never in a file you commit. |
| `DUO_MAX_SPEND_USD` | no | Spend cap for one run. Default `1.00`. |

## Run

```sh
npx tsx agent.ts suppliers.example.json --dry-run    # plan and cost, free
DUO_PAYER_KEY=0x... npx tsx agent.ts suppliers.example.json
```

Output for the sample file:

| Supplier | Decision | Why |
|---|---|---|
| SUP-001 (NL) | approve | IBAN valid, BTW number valid, account holder matches |
| SUP-002 (DE) | approve | IBAN built from Bankleitzahl + Kontonummer, USt-IdNr valid |
| SUP-003 (FR) | reject | IBAN fails its mod-97 check |
| SUP-004 (IT) | review | account holder name differs from the supplier name |

Put your own suppliers in a JSON file with the same fields (`id`, `name`, `country`, then `iban` or `bank` + `account` or `bban`, `vatId`, optional `vatKind` and `accountHolder`).

## Use it in your own code

`checkSupplier(client, supplier)` is exported. Pass any `createClient(...)` client, for example inside a queue worker or an onboarding webhook.
