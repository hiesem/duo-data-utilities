IBAN, ISIN, VAT/tax ID and GTIN barcode validation plus 29 more utilities for AI agents. Pay per call ($0.05 USDC on Base via x402), no API key, no signup.

Timezone and DST, geo distance and geohash, hashes and JWT decoding, airport, country, currency and NUTS lookups, money split, base conversion and more. Every call is one HTTP GET, paid per request.

Also crypto derivatives data for trading agents: perp funding rates, funding arbitrage, open interest, futures basis, implied volatility, liquidations and order book depth across Bybit, Hyperliquid, dYdX, Gate, Kraken, Bitfinex, Deribit and OKX, at $0.003 or $0.005 per call ([below](#crypto-derivatives-data-perp-funding-rates-open-interest-futures-basis-implied-volatility-liquidations-order-book-depth)).

## Install

```sh
npm install duo-data-utilities viem
```

`viem` creates the wallet account that pays. This package also depends on it. Node.js 20 or later.

Python (not on PyPI, install from GitHub):

```sh
pip install "git+https://github.com/hiesem/duo-data-utilities#subdirectory=python"
```

## Quick start

```ts
import { privateKeyToAccount } from "viem/accounts";
import { createClient } from "duo-data-utilities";

// Your wallet holds USDC on Base. Read the key from the environment, never a literal.
const client = createClient({ account: privateKeyToAccount(process.env.DUO_PAYER_KEY as `0x${string}`) });

const iban = await client.iban.validate({ iban: "NL91 ABNA 0417 1643 00" }); // $0.05
console.log(iban.valid, iban.country); // true NL
```

## Counterparty check

`checkCounterparty` runs three checks in one call: IBAN (`/v1/id/iban`), tax ID (`/v1/id/national`) and country (`/v1/ref/country`). It costs $0.15.

```ts
const check = await client.checkCounterparty({
  iban: "NL91 ABNA 0417 1643 00",
  country: "NL",
  taxIdType: "bsn",
  taxId: "111222333",
});
console.log(check.verdict, check.reasons); // "pass", "fail" or "review"
```

- `fail`: the IBAN or the tax ID fails its checksum, the country is not an ISO 3166-1 country, or the API rejects an input as malformed.
- `review`: the IBAN country differs from the tax ID country, or the API does not cover that country or tax ID kind.
- `pass`: every check passed.

Structure and checksum only. The check does not query a company register, a bank or a tax authority, and it does not confirm that an account exists. `UK` is read as `GB`.

## Crypto derivatives data: perp funding rates, open interest, futures basis, implied volatility, liquidations, order book depth

`client.derivs` calls https://derivs.duoleads.com: crypto derivatives data from 8 exchanges (Bybit, Hyperliquid, dYdX, Gate, Kraken, Bitfinex, Deribit, OKX) for trading agents and bots. Perpetual futures (perp) funding rates with predicted funding, funding rate history and a funding arbitrage scanner, a perp screener, open interest (OI), futures basis and term structure, options implied volatility (IV), skew and max pain, liquidations, and order book depth with slippage. **$0.003 or $0.005 per call**, same wallet, same x402 payment, no API key.

```ts
import { privateKeyToAccount } from "viem/accounts";
import { createClient, createDerivsClient } from "duo-data-utilities";

const account = privateKeyToAccount(process.env.DUO_PAYER_KEY as `0x${string}`);
const client = createClient({ account });

const funding = await client.derivs.fundingRates({ coin: "BTC" }); // $0.003
for (const v of funding.venues) console.log(v.venue, v.apr_pct, v.next_funding_time);

const arb = await client.derivs.fundingArbitrage({ min_apr: 20, min_volume_usd: 1_000_000 }); // $0.005, all coins
const snap = await client.derivs.derivativesSnapshot({ coin: "ETH" }); // $0.005: funding, OI, basis, liquidations, long/short

// Or a derivs-only client:
const derivs = createDerivsClient({ account });
await derivs.openInterest({ coin: "SOL" }); // $0.003
```

```python
import os

from eth_account import Account
from duo_data_utilities import DerivsClient, DuoClient

client = DuoClient(Account.from_key(os.environ["DUO_PAYER_KEY"]))
rates = client.derivs.funding_rates(coin="BTC")               # $0.003
book = client.derivs.orderbook(coin="BTC", size_usd=250_000)  # $0.003
derivs = DerivsClient(Account.from_key(os.environ["DUO_PAYER_KEY"]))  # derivs only
```

- **Price guard:** `client.derivs` has its own cap, $0.005 per call by default. `createClient({ account, derivs: { maxPriceUsd: 0.003 } })` refuses the $0.005 routes (Python: `derivs_max_price_usd=0.003`). The other rules are the same: Base USDC only, only to `0xCD673f7e1daD254347AEab6be0DEFe8b9C6b3A39`, nothing is signed before the check.
- **Not charged:** bad input is a free 400 with `error.expected`. When fewer venues answer than the route needs, the answer is a 503 and nothing is charged. Both throw `DuoApiError`.
- **Answers** are the JSON body itself (no `data` envelope), with `venues_missing`, `units`, `as_of` and a `see_also` pointer to the next useful route. TypeScript types: `DerivsFundingRatesData` and so on.
- **Coins:** BTC, btc, BTCUSDT, BTC-PERP, XBT, 1000PEPE and kPEPE all name a coin.
- **MCP:** the same 10 tools at `https://derivs.duoleads.com/mcp`. Snippets for Claude Code, Claude Desktop, Cursor and VS Code: [mcp/README.md](mcp/README.md#crypto-derivatives-mcp-server-perp-funding-rates-open-interest-futures-basis-implied-volatility-liquidations-order-book-depth).
- Data only, not investment advice, not affiliated with any exchange.

| TypeScript | Python | Route | Price | What it returns |
|---|---|---|---|---|
| `derivs.fundingRates` | `derivs.funding_rates` | `/v1/funding-rates` | $0.003 | Perp funding rates per exchange for one coin: rate, 8h rate, APR, next funding, predicted funding (incl. Binance and Bybit), last 24 prints |
| `derivs.fundingHistory` | `derivs.funding_history` | `/v1/funding-history` | $0.003 | Funding rate history of one coin on one exchange, up to 30 days, with avg/min/max/% positive |
| `derivs.fundingArbitrage` | `derivs.funding_arbitrage` | `/v1/funding-arbitrage` | $0.005 | Funding arbitrage scanner for all coins: widest cross-venue spread, long and short venue, fee-adjusted net APR, breakeven days |
| `derivs.perpScreener` | `derivs.perp_screener` | `/v1/perp-screener` | $0.005 | Perp screener: every perpetual across venues, sorted by funding APR, open interest, 24h volume or 24h change |
| `derivs.openInterest` | `derivs.open_interest` | `/v1/open-interest` | $0.003 | Open interest (OI) per exchange in coins and USD, share, and 1h/4h/24h OI change |
| `derivs.basis` | `derivs.basis` | `/v1/basis` | $0.003 | Futures basis and term structure (annualised, contango/backwardation), perp premium, predicted funding |
| `derivs.options` | `derivs.options` | `/v1/options` | $0.003 | Implied volatility (ATM IV), 25-delta skew, put/call OI ratio, max pain, DVOL; options chain with greeks for one expiry |
| `derivs.liquidations` | `derivs.liquidations` | `/v1/liquidations` | $0.003 | Long and short liquidations in USD per venue over 1-24h, totals and the largest events |
| `derivs.orderbook` | `derivs.orderbook` | `/v1/orderbook` | $0.003 | Order book depth within 0.1/0.5/1/2% of mid, spread, imbalance, slippage for your order size, walls |
| `derivs.derivativesSnapshot` | `derivs.derivatives_snapshot` | `/v1/derivatives-snapshot` | $0.005 | One-call snapshot: funding, open interest, perp premium and nearest basis, 24h liquidations, long/short ratio |

Derivs docs: https://derivs.duoleads.com/docs · OpenAPI: https://derivs.duoleads.com/openapi.json · Index: https://derivs.duoleads.com/llms.txt · Terms: https://derivs.duoleads.com/terms · Privacy: https://derivs.duoleads.com/privacy

## Methods

Every method costs $0.05 per call. Each method's JSDoc gives the route and the parameters. `client.call(path, params)` calls any route, and `client.callWithReceipt(path, params)` also returns the settlement receipt.

| Method | Route | What it does |
|---|---|---|
| `iban.validate` | `/v1/id/iban` | IBAN validator: length, mod-97 check digits, bank/branch/account breakdown (89 countries) |
| `iban.generate` | `/v1/id/iban-build` | IBAN generator: build an IBAN from country and BBAN or bank/branch/account, computing check digits |
| `taxId.validate` | `/v1/id/national` | VAT, tax ID and national ID validator: 23 countries, checksum only (VAT formats BE, DE, FR, IT, PL, AT, CH, IE) |
| `isin.validate` | `/v1/id/security` | ISIN validator plus CUSIP, SEDOL and FIGI check-digit validation; builds an ISIN from an NSIN |
| `barcode.validate` | `/v1/id/gs1` | GTIN barcode validator: EAN-13, UPC-A (GTIN-12), GTIN-8/14, GLN and SSCC check digits |
| `timezone.convert` | `/v1/time/zone` | Timezone converter: instant to local time in an IANA time zone and back, with UTC offset and DST state |
| `timezone.dstTransitions` | `/v1/time/dst` | DST transitions: next daylight-saving time changes for an IANA time zone |
| `businessDays.calculate` | `/v1/time/business-days` | Business days calculator: add or count working days with your weekend mask and holiday list |
| `rrule.expand` | `/v1/time/rrule` | RRULE expander: RFC 5545 recurrence rule to concrete occurrence dates |
| `calendar.convert` | `/v1/time/calendar` | Calendar converter: Gregorian to Hijri, Hebrew, Japanese era, Persian and more, plus Easter date |
| `text.similarity` | `/v1/text/similarity` | String similarity: Levenshtein, Jaro-Winkler distance and Soundex/Metaphone phonetic keys |
| `text.slug` | `/v1/text/slug` | Slug generator: Unicode-aware URL slug with transliteration |
| `text.transliterate` | `/v1/text/transliterate` | Cyrillic transliteration to Latin (ISO 9:1995, BGN/PCGN Russian) |
| `text.unicode` | `/v1/text/unicode` | Unicode normalization (NFC/NFKC), script detection and homoglyph/confusable check |
| `hash.generate` | `/v1/code/hash` | Hash generator: SHA-256, SHA-512, SHA-3, Keccak-256, BLAKE2 and HMAC digests |
| `punycode.convert` | `/v1/code/idn` | Punycode converter: IDN domain to ASCII and back, with IDNA2008 label validation |
| `jwt.decode` | `/v1/code/jwt` | JWT decoder: header, claims and expiry state (no signature verification) |
| `semver.compare` | `/v1/code/semver` | Semver parser: parse and compare versions, check range satisfaction |
| `url.parse` | `/v1/code/url` | URL parser: parse, canonicalize and extract the registrable domain (eTLD+1) |
| `geohash.encodeDecode` | `/v1/geo/geohash` | Geohash encoder and decoder with neighbour cells |
| `plusCode.encodeDecode` | `/v1/geo/pluscode` | Plus code (Open Location Code) encoder and decoder |
| `polygon.check` | `/v1/geo/polygon` | Point in polygon check, plus bounding box, centroid and area for GeoJSON |
| `distance.calculate` | `/v1/geo/distance` | Distance calculator: geodesic distance, bearing and destination point on WGS-84 |
| `cryptoAddress.validate` | `/v1/chain/address` | Crypto address validator: detect the blockchain and verify the checksum (EVM, Bitcoin, Solana and more) |
| `solidity.selector` | `/v1/chain/selector` | Solidity function selector: Keccak-256, 4-byte selector and event topic from a signature |
| `airport.lookup` | `/v1/ref/airport` | Airport lookup by IATA or ICAO code: name, coordinates, elevation, time zone; nearest airports |
| `country.lookup` | `/v1/ref/country` | Country lookup: ISO 3166 codes, currency, TLD, UN region and ISO 3166-2 subdivisions |
| `currency.lookup` | `/v1/ref/currency` | Currency lookup: ISO 4217 codes, names, minor units and cash rounding |
| `nuts.lookup` | `/v1/ref/nuts` | NUTS region lookup: EU statistical region codes, names and hierarchy |
| `money.split` | `/v1/num/allocate` | Money split: allocate an amount into shares with no rounding loss |
| `base.convert` | `/v1/num/radix` | Base converter: integers between number bases 2 to 36 (hex, binary, octal) |
| `statistics.calculate` | `/v1/num/stats` | Statistics calculator: mean, median, standard deviation, quartiles and percentiles |
| `numberWords.convert` | `/v1/num/words` | Number to words in 12 languages, with ordinal and currency forms |

## MCP

The MCP server is at `https://api.duoleads.com/mcp` (Streamable HTTP). `tools/list` is free. Each `tools/call` costs $0.05 and needs an x402-capable client or wallet bridge. The derivatives tools are a second server at `https://derivs.duoleads.com/mcp` ($0.003 or $0.005 per call). See [mcp/README.md](mcp/README.md) for Claude Code, Claude Desktop, Cursor, VS Code and AgentCash.

## Python

Python 3.10 or later. The client is typed (`py.typed`) and uses `requests` with x402's EVM signer. Routes and method names match the TypeScript client, in snake_case.

```python
import os

from eth_account import Account
from duo_data_utilities import DuoClient

client = DuoClient(Account.from_key(os.environ["DUO_PAYER_KEY"]))  # your wallet, never a literal key
print(client.iban.validate(iban="NL91 ABNA 0417 1643 00")["valid"])

check = client.check_counterparty(iban="NL91 ABNA 0417 1643 00", country="NL", tax_id_type="bsn", tax_id="111222333")
print(check.verdict, check.reasons)
```

`DuoClient(account, *, max_price_usd=0.05, timeout=None, pay_to=<service address>)` applies the same price guard. Pass `session=` with a `requests.Session` that already pays to skip the guard. `from_` is the Python name for the `from` query parameter.

## Pricing and the price guard

- Every main API route costs $0.05 per call, paid in USDC on Base (`eip155:8453`) with x402 v2. Derivs routes cost $0.003 or $0.005 and have their own cap (default $0.005); see the derivatives section.
- `maxPriceUsd` defaults to `0.05`. Before anything is signed, the client refuses a payment requirement that asks for more than that, a network other than Base, an asset other than Base USDC, or another payee. A refused call makes no payment and throws `PriceGuardError`.
- The client only signs payments to the service's public address `0xCD673f7e1daD254347AEab6be0DEFe8b9C6b3A39` (`payTo` option; `pay_to` in Python). Set it if you point `baseUrl` at another deployment.
- The client never retries a paid call on its own.
- Plain `http://` is refused except for loopback addresses (`localhost`, `127.0.0.1`, `[::1]`).
- With `fetch` instead of `account`, you pass a fetch that already pays. The price guard cannot check payments made inside it, so use `account` to keep the guard.

## Examples

Runnable agents in [`examples/`](examples/). Each folder has a README with setup, environment variables and cost.

| Example | Language | What it does |
|---|---|---|
| [supplier-onboarding-agent](examples/supplier-onboarding-agent/) | TypeScript | Supplier / vendor onboarding check: builds and validates IBANs, checks VAT numbers, compares the account holder name. Approve, review or reject per supplier. |
| [kyb-payout-agent-python](examples/kyb-payout-agent-python/) | Python | KYB payout validation agent with Claude tool use: IBAN, VAT / tax ID, country and name checks, with a spend cap. |
| [mcp-paid-client](examples/mcp-paid-client/) | TypeScript | MCP client for `https://api.duoleads.com/mcp` that pays each `tools/call` with x402, plus an MCP host config. |
| [funding-arbitrage-watcher](examples/funding-arbitrage-watcher/) | TypeScript | Funding rate arbitrage watcher: scans perp funding spreads across 8 exchanges every few minutes and alerts on new fee-adjusted opportunities. $0.005 per scan; the default run costs $0.06. |
| [derivs-snapshot-loop-python](examples/derivs-snapshot-loop-python/) | Python | Per-coin derivatives snapshot loop: funding, open interest, basis, liquidations and long/short for each coin; flags crowded positioning. $0.005 per coin per round; the default run costs $0.06. |
| [node-basic.ts](examples/node-basic.ts) | TypeScript | IBAN, time zone, counterparty check and a settlement receipt in one script. |
| [vercel-ai-sdk-tool.ts](examples/vercel-ai-sdk-tool.ts) | TypeScript | IBAN and counterparty checks as Vercel AI SDK tools. |
| [langchain_tool.py](examples/langchain_tool.py) | Python | IBAN and counterparty checks as LangChain tools. |
| [claude-mcp.md](examples/claude-mcp.md) | | Adding the MCP server to Claude Code. |

Main API calls cost $0.05 and derivs calls $0.003 or $0.005, in USDC on Base, paid by the wallet you configure. The examples' tests run offline with mocked responses; nothing in CI pays.

## User-Agent and privacy

The SDK sends a User-Agent naming the SDK and version; the API stores only a coarse client class, see https://api.duoleads.com/privacy

- TypeScript: `duo-data-utilities-js/<version> (+https://github.com/hiesem/duo-data-utilities)`. Override it with `createClient({ userAgent })`, or append your own product: ``userAgent: `${SDK_USER_AGENT} my-agent/1.0` ``.
- Python: `duo-data-utilities-py/<version> (+https://github.com/hiesem/duo-data-utilities)`. Override it with `DuoClient(..., user_agent=...)`, or append to `duo_data_utilities.USER_AGENT`.
- In browsers a page cannot set User-Agent, so the client sends none there, and it adds no other header in its place (one would make the browser send a CORS preflight, which the API does not accept). The browser's own User-Agent is sent instead.

## What this is not

- Not a registry lookup. IBAN, tax ID and VAT checks are structure and checksum only.
- Not financial, legal or tax advice. Each response carries a disclaimer.
- Derivatives data is data only: not investment advice, not a benchmark, not affiliated with any exchange.

## Links

- API docs: https://api.duoleads.com/docs
- OpenAPI: https://api.duoleads.com/openapi.json
- Machine-readable index: https://api.duoleads.com/llms.txt
- Terms: https://api.duoleads.com/terms
- Privacy: https://api.duoleads.com/privacy

The HTTP routes also work without this SDK. An unpaid `GET` returns `402 Payment Required` with a `PAYMENT-REQUIRED` header, and any x402 v2 client can pay that challenge.

## Development

```sh
npm install
npm run generate        # rebuild src/generated.ts and src/derivs-generated.ts from spec/ (npm test checks they are current)
python3 python/scripts/generate.py   # the same for the Python package
npm run typecheck
npm test
npm run build
```

`spec/` holds the snapshots the code is generated from. See `spec/README.md`.

## License

MIT. See [LICENSE](LICENSE).
