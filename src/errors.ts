/** The API answered with an error envelope, or with a response that is not a valid envelope. */
export class DuoApiError extends Error {
  /** Error code from the envelope, e.g. `INVALID_PARAM`, or `HTTP_<status>` when there is no envelope. */
  readonly code: string;
  /** The offending query parameter, or `null`. */
  readonly param: string | null;
  /** The accepted form, or `null`. */
  readonly expected: string | null;
  /** HTTP status of the response. */
  readonly status: number;
  /** Route path that was called, e.g. `/v1/id/iban`. */
  readonly route: string;
  /** Request id from the envelope's `meta`, when present. */
  readonly requestId: string | null;

  constructor(init: {
    code: string;
    message: string;
    param?: string | null;
    expected?: string | null;
    status: number;
    route: string;
    requestId?: string | null;
  }) {
    super(init.message);
    this.name = "DuoApiError";
    this.code = init.code;
    this.param = init.param ?? null;
    this.expected = init.expected ?? null;
    this.status = init.status;
    this.route = init.route;
    this.requestId = init.requestId ?? null;
  }
}

/**
 * The price guard refused a payment requirement before anything was signed.
 * No payment was made for the call that raised it.
 */
export class PriceGuardError extends Error {
  /** One entry per refused requirement, e.g. `amount 60000 atomic units ($0.06) is above the maximum $0.05`. */
  readonly reasons: string[];
  /** The per-call maximum in effect, in USD. */
  readonly maxPriceUsd: number;

  constructor(reasons: string[], maxPriceUsd: number) {
    super(`Refused to pay: ${reasons.join("; ")}. Nothing was signed (maximum $${maxPriceUsd} per call).`);
    this.name = "PriceGuardError";
    this.reasons = reasons;
    this.maxPriceUsd = maxPriceUsd;
  }
}
