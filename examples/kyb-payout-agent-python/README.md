# KYB payout validation agent: Claude tool use with IBAN, VAT / tax ID and name checks (Python)

A Python agent that checks a business beneficiary before a payout. You describe the payout in plain language; Claude (Anthropic API, tool use) decides which checks to run and calls tools backed by [duo-data-utilities](../../README.md):

| Tool | Route | What it checks |
|---|---|---|
| `validate_iban` | `/v1/id/iban` | IBAN length, mod-97 check digits, bank code |
| `build_iban` | `/v1/id/iban-build` | IBAN from country, bank code and account number |
| `validate_tax_id` | `/v1/id/national` | VAT number, tax ID or company number checksum: NL btw/KvK, DE USt-IdNr, FR TVA/SIREN/SIRET, IT P.IVA, ES CIF, UK UTR/CRN, AU ABN, US EIN and more (23 countries) |
| `lookup_country` | `/v1/ref/country` | ISO 3166 country, currencies, UN region |
| `compare_names` | `/v1/text/similarity` | beneficiary name vs account holder name (Jaro-Winkler) |

It ends with `VERDICT: APPROVE`, `REVIEW` or `REJECT` and the reasons. Structure and checksum only: no company register, bank or tax authority is queried. Use it as a pre-check in a KYB, vendor onboarding or payout approval flow, not as proof that a company or account exists.

`--rules` runs the same checks on a JSON record without an LLM.

## Cost

Each tool call costs **$0.05 in USDC on Base**, paid per request with x402 v2 from your wallet. No API key for the data API, no signup. The agent stops paying after `DUO_MAX_CALLS` calls (default 6, at most $0.30 per run). The client refuses to sign more than $0.05 per call, or a payment to anyone but the service. Claude usage is billed separately by Anthropic.

## Setup

Python 3.10 or later.

```sh
cd examples/kyb-payout-agent-python
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
```

| Variable | Required | What it is |
|---|---|---|
| `DUO_PAYER_KEY` | yes | 0x-prefixed private key of a Base wallet you control that holds a little USDC. Use a dedicated low-balance wallet; keep the key in the environment. |
| `ANTHROPIC_API_KEY` | for the Claude agent | Your Anthropic API key (or an `ant auth login` profile). Not needed with `--rules`. |
| `DUO_MAX_CALLS` | no | Paid calls per run. Default `6`. |

## Run

```sh
python kyb_agent.py "Pay 1,250 EUR to Muster Maschinenbau GmbH (DE), Bankleitzahl 37040044, Konto 0532013000, USt-IdNr DE136695976, account holder Muster Maschinenbau GmbH"

python kyb_agent.py --rules beneficiary.example.json     # no LLM: 4 calls, $0.20
```

The model is `claude-opus-5-5`, with server-side refusal fallbacks enabled (`fallbacks="default"`). Change `MODEL` in `kyb_agent.py` to use another Claude model.

## Use it in your own code

`PaidTools(DuoClient(...))` runs the tools with a spend cap; `TOOLS` holds the strict JSON schemas. Plug both into any tool-calling loop (LangGraph, the OpenAI Agents SDK, or your own).
