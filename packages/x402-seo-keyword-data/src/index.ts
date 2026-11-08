// x402-seo-keyword-data: the keywords.duoleads.com client of duo-data-utilities, published on its own.
// The code is bundled from the shared source in ../../src at build time.
export {
  assertKeywordsPath,
  buildKeywordsQuery,
  createKeywordsClient,
  createKeywordsClient as createClient,
  DEFAULT_KEYWORDS_BASE_URL,
  DEFAULT_KEYWORDS_MAX_PRICE_USD,
  KEYWORDS_MAX_ROUTE_PRICE_USD,
  KEYWORDS_MCP_URL,
  KEYWORDS_ROUTES,
} from "../../../src/keywords.js";
export type {
  InterestByRegionData,
  KeywordIdeasData,
  KeywordIdeasParams,
  KeywordMarket,
  KeywordMetrics,
  KeywordOverviewData,
  KeywordOverviewParams,
  KeywordsClient,
  KeywordsClientOptions,
  KeywordsPaidResult,
  KeywordsRoute,
  RelatedQueriesData,
  SearchVolumeParams,
  TrendData,
  TrendsParams,
  TrendsTimeframe,
} from "../../../src/keywords.js";
export * from "../../../src/seo-generated.js";
export { DuoApiError, PriceGuardError } from "../../../src/errors.js";
export { BASE_NETWORK, BASE_USDC_ADDRESS } from "../../../src/price-guard.js";
export type { EvmSigner, SettlementReceipt } from "../../../src/transport.js";
export { SDK_USER_AGENT, SDK_VERSION } from "../../../src/version.js";
