// Replaced at build time (tsup) and test time (vitest) with the "version" field of package.json,
// so the version is never copied by hand.
declare const __DUO_SDK_VERSION__: string | undefined;
// The npm package name, set at build time by each package's tsup config (the per-service packages share this code).
declare const __DUO_SDK_NAME__: string | undefined;

/** This package's version, from package.json. */
export const SDK_VERSION: string = typeof __DUO_SDK_VERSION__ === "string" ? __DUO_SDK_VERSION__ : "0.0.0-dev";

/** The User-Agent the client sends outside browsers: SDK name, version and repository. */
export const SDK_USER_AGENT = `${typeof __DUO_SDK_NAME__ === "string" ? __DUO_SDK_NAME__ : "duo-data-utilities"}-js/${SDK_VERSION} (+https://github.com/hiesem/duo-data-utilities)`;
