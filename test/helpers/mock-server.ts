import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  path: string;
  search: string;
  /** Base64 PAYMENT-SIGNATURE header, present only on a paid retry. */
  paymentSignature: string | null;
}

export interface MockReply {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface MockServer {
  baseUrl: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

/** Local HTTP server on 127.0.0.1. Every request is recorded and answered by `reply`. No internet access. */
export async function startMockServer(reply: (request: RecordedRequest) => MockReply): Promise<MockServer> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const signature = req.headers["payment-signature"];
    const recorded: RecordedRequest = {
      method: req.method ?? "GET",
      path: url.pathname,
      search: url.search,
      paymentSignature: typeof signature === "string" ? signature : null,
    };
    requests.push(recorded);
    const answer = reply(recorded);
    res.writeHead(answer.status, { "content-type": "application/json; charset=utf-8", ...answer.headers });
    res.end(answer.body === undefined ? "" : JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
