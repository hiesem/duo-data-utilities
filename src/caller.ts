/** Calls one route and resolves to its `data` object. Used by the generated methods. */
export type CallRoute = <T>(path: string, params: object) => Promise<T>;

// Every route is GET /v1/{group}/{name}. Anything else is refused before a request is made.
const ROUTE_PATH = /^\/v1\/[a-z]+\/[a-z0-9-]+$/;

export function assertRoutePath(path: string): void {
  if (!ROUTE_PATH.test(path)) {
    throw new TypeError(`not a route path: ${JSON.stringify(path)} (expected /v1/<group>/<name>)`);
  }
}

/** Query string for the given parameters. Booleans become "true"/"false"; null and undefined are omitted. */
export function buildQuery(params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      search.append(key, String(value));
    } else {
      throw new TypeError(`parameter ${key} must be a string, number or boolean`);
    }
  }
  return search.toString();
}
