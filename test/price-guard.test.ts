import { describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createClient, PriceGuardError, type EvmSigner } from "../src/index.js";
import { formatUsd, requirementProblem, usdToAtomic } from "../src/price-guard.js";
import {
  BASE_USDC,
  challengeHeader,
  encodeBase64Json,
  envelope,
  fixtureChallenge,
  PAY_TO,
  paymentResponseHeader,
  type Requirement,
} from "./helpers/challenge.js";
import { startMockServer, type MockReply } from "./helpers/mock-server.js";

// A throwaway account generated at run time. Its key is never written to disk or to the repository.
function spySigner() {
  const account = privateKeyToAccount(generatePrivateKey());
  const signTypedData = vi.fn((message: unknown) => account.signTypedData(message as Parameters<typeof account.signTypedData>[0]));
  const signer = { address: account.address, signTypedData } as unknown as EvmSigner;
  return { account, signer, signTypedData };
}

function decodePaymentSignature(header: string) {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
    accepted: Requirement;
    payload: { authorization: { from: string; to: string; value: string } };
  };
}

const IBAN_PATH = "/v1/id/iban";
const IBAN_PARAMS = { iban: "NL91 ABNA 0417 1643 00" };

describe("USD and atomic amounts", () => {
  it("converts USD to USDC atomic units", () => {
    expect(usdToAtomic(0.05)).toBe(50000n);
    expect(usdToAtomic(1)).toBe(1000000n);
  });

  it("rejects amounts that cannot be represented or are not positive", () => {
    expect(() => usdToAtomic(0)).toThrow(RangeError);
    expect(() => usdToAtomic(-0.05)).toThrow(RangeError);
    expect(() => usdToAtomic(Number.NaN)).toThrow(RangeError);
    expect(() => usdToAtomic(1e-9)).toThrow(RangeError);
  });

  it("formats atomic units as dollars", () => {
    expect(formatUsd(50000n)).toBe("$0.05");
    expect(formatUsd(60000n)).toBe("$0.06");
    expect(formatUsd(1000000n)).toBe("$1.00");
    expect(formatUsd(1n)).toBe("$0.000001");
  });
});

describe("requirementProblem", () => {
  const maxAtomic = 50000n;
  const good = fixtureChallenge().accepts[0] as Requirement;

  it("accepts the real $0.05 Base USDC requirement from the saved challenge", () => {
    expect(good).toMatchObject({ scheme: "exact", network: "eip155:8453", amount: "50000", asset: BASE_USDC, payTo: PAY_TO });
    expect(requirementProblem(good, maxAtomic)).toBeNull();
  });

  it.each([
    ["an amount above the cap", { amount: "60000" }, /above the maximum \$0\.05/],
    ["a zero amount", { amount: "0" }, /amount is zero/],
    ["a decimal amount", { amount: "0.05" }, /not an integer in atomic USDC units/],
    ["another network", { network: "eip155:84532" }, /is not eip155:8453 \(Base\)/],
    ["another asset", { asset: "0x0000000000000000000000000000000000000001" }, /is not Base USDC/],
    ["another scheme", { scheme: "upto" }, /is not "exact"/],
    ["another payee", { payTo: "0x0000000000000000000000000000000000000002" }, /is not the expected payee/],
  ])("refuses %s", (_label, change, message) => {
    expect(requirementProblem({ ...good, ...change } as Partial<Requirement>, maxAtomic)).toMatch(message);
  });

  it("accepts any payee only when payTo is null", () => {
    const other = { ...good, payTo: "0x0000000000000000000000000000000000000002" } as Partial<Requirement>;
    expect(requirementProblem(other, maxAtomic, null)).toBeNull();
    expect(requirementProblem(other, maxAtomic, "0x0000000000000000000000000000000000000002")).toBeNull();
  });
});

describe("paying with a wallet", () => {
  it("pays the real $0.05 challenge once and returns the data and the receipt", async () => {
    const { account, signer, signTypedData } = spySigner();
    const server = await startMockServer((request): MockReply => {
      if (!request.paymentSignature) return { status: 402, headers: { "PAYMENT-REQUIRED": challengeHeader() } };
      return {
        status: 200,
        headers: { "PAYMENT-RESPONSE": paymentResponseHeader(account.address) },
        body: envelope(IBAN_PATH, { valid: true, country: "NL", reason: null }),
      };
    });
    try {
      const client = createClient({ account: signer, baseUrl: server.baseUrl });
      const result = await client.callWithReceipt(IBAN_PATH, IBAN_PARAMS);

      expect(result.data).toEqual({ valid: true, country: "NL", reason: null });
      expect(result.meta).toMatchObject({ price_usd: "0.05" });
      expect(result.receipt).toMatchObject({ success: true, network: "eip155:8453", payer: account.address });
      expect(server.requests.map((r) => r.search)).toEqual(["?iban=NL91+ABNA+0417+1643+00", "?iban=NL91+ABNA+0417+1643+00"]);
      expect(signTypedData).toHaveBeenCalledTimes(1);

      const signed = decodePaymentSignature(server.requests[1]?.paymentSignature ?? "");
      expect(signed.payload.authorization).toMatchObject({ from: account.address, to: PAY_TO, value: "50000" });
      expect(signed.accepted).toMatchObject({ amount: "50000", asset: BASE_USDC, network: "eip155:8453" });
    } finally {
      await server.close();
    }
  });

  it("refuses a $0.06 challenge before anything is signed", async () => {
    const { signer, signTypedData } = spySigner();
    const server = await startMockServer((): MockReply => ({
      status: 402,
      headers: { "PAYMENT-REQUIRED": challengeHeader((c) => (c.accepts[0] as Requirement).amount = "60000") },
    }));
    try {
      const client = createClient({ account: signer, baseUrl: server.baseUrl });
      await expect(client.call(IBAN_PATH, IBAN_PARAMS)).rejects.toBeInstanceOf(PriceGuardError);
      await expect(client.call(IBAN_PATH, IBAN_PARAMS)).rejects.toThrow(/above the maximum \$0\.05/);
      expect(signTypedData).not.toHaveBeenCalled();
      expect(server.requests.every((r) => r.paymentSignature === null)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it.each([
    ["a testnet network", (c: { accepts: Requirement[] }) => ((c.accepts[0] as Requirement).network = "eip155:84532")],
    ["a non-USDC asset", (c: { accepts: Requirement[] }) => ((c.accepts[0] as Requirement).asset = "0x0000000000000000000000000000000000000001")],
    ["another payee", (c: { accepts: Requirement[] }) => ((c.accepts[0] as Requirement).payTo = "0x0000000000000000000000000000000000000002")],
  ])("refuses %s without signing", async (_label, edit) => {
    const { signer, signTypedData } = spySigner();
    const server = await startMockServer((): MockReply => ({ status: 402, headers: { "PAYMENT-REQUIRED": challengeHeader(edit) } }));
    try {
      const client = createClient({ account: signer, baseUrl: server.baseUrl });
      await expect(client.call(IBAN_PATH, IBAN_PARAMS)).rejects.toBeInstanceOf(PriceGuardError);
      expect(signTypedData).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("pays the affordable option when a challenge offers both a $0.06 and a $0.05 option", async () => {
    const { account, signer } = spySigner();
    const server = await startMockServer((request): MockReply => {
      if (!request.paymentSignature) {
        return {
          status: 402,
          headers: {
            "PAYMENT-REQUIRED": challengeHeader((c) => {
              const cheap = c.accepts[0] as Requirement;
              c.accepts = [{ ...cheap, amount: "60000" }, cheap];
            }),
          },
        };
      }
      return { status: 200, headers: { "PAYMENT-RESPONSE": paymentResponseHeader(account.address) }, body: envelope(IBAN_PATH, {}) };
    });
    try {
      await createClient({ account: signer, baseUrl: server.baseUrl }).call(IBAN_PATH, IBAN_PARAMS);
      const signed = decodePaymentSignature(server.requests[1]?.paymentSignature ?? "");
      expect(signed.payload.authorization.value).toBe("50000");
    } finally {
      await server.close();
    }
  });

  it("honours a higher maxPriceUsd", async () => {
    const { account, signer } = spySigner();
    const server = await startMockServer((request): MockReply => {
      if (!request.paymentSignature) return { status: 402, headers: { "PAYMENT-REQUIRED": challengeHeader((c) => (c.accepts[0] as Requirement).amount = "60000") } };
      return { status: 200, headers: { "PAYMENT-RESPONSE": paymentResponseHeader(account.address) }, body: envelope(IBAN_PATH, {}) };
    });
    try {
      await createClient({ account: signer, baseUrl: server.baseUrl, maxPriceUsd: 0.1 }).call(IBAN_PATH, IBAN_PARAMS);
      expect(decodePaymentSignature(server.requests[1]?.paymentSignature ?? "").payload.authorization.value).toBe("60000");
    } finally {
      await server.close();
    }
  });

  it("refuses a challenge it cannot read, without signing", async () => {
    const { signer, signTypedData } = spySigner();
    const server = await startMockServer((): MockReply => ({ status: 402, headers: { "PAYMENT-REQUIRED": encodeBase64Json({ x402Version: 2 }) } }));
    try {
      await expect(createClient({ account: signer, baseUrl: server.baseUrl }).call(IBAN_PATH, IBAN_PARAMS)).rejects.toBeInstanceOf(PriceGuardError);
      expect(signTypedData).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
