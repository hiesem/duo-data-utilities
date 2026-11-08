// x402-social-media-data: the social.duoleads.com client of duo-data-utilities, published on its own.
// The code is bundled from the shared source in ../../src at build time.
export {
  assertSocialPath,
  buildSocialQuery,
  createSocialClient,
  createSocialClient as createClient,
  DEFAULT_SOCIAL_BASE_URL,
  DEFAULT_SOCIAL_MAX_PRICE_USD,
  SOCIAL_MCP_URL,
} from "../../../src/social.js";
export type { SocialClient, SocialClientOptions, SocialPaidResult } from "../../../src/social.js";
export * from "../../../src/social-generated.js";
export { DuoApiError, PriceGuardError } from "../../../src/errors.js";
export { BASE_NETWORK, BASE_USDC_ADDRESS } from "../../../src/price-guard.js";
export type { EvmSigner, SettlementReceipt } from "../../../src/transport.js";
export { SDK_USER_AGENT, SDK_VERSION } from "../../../src/version.js";
