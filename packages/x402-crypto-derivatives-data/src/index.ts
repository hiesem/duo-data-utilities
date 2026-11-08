// x402-crypto-derivatives-data: the derivs.duoleads.com client of duo-data-utilities, published on its own.
// The code is bundled from the shared source in ../../src at build time.
export {
  assertDerivsPath,
  buildDerivsQuery,
  createDerivsClient,
  createDerivsClient as createClient,
  DEFAULT_DERIVS_BASE_URL,
  DEFAULT_DERIVS_MAX_PRICE_USD,
  DERIVS_MCP_URL,
  derivsNumber,
} from "../../../src/derivs.js";
export type { DerivsClient, DerivsClientOptions, DerivsPaidResult } from "../../../src/derivs.js";
export * from "../../../src/derivs-generated.js";
export { DuoApiError, PriceGuardError } from "../../../src/errors.js";
export { BASE_NETWORK, BASE_USDC_ADDRESS } from "../../../src/price-guard.js";
export type { EvmSigner, SettlementReceipt } from "../../../src/transport.js";
export { SDK_USER_AGENT, SDK_VERSION } from "../../../src/version.js";
