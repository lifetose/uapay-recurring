import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createMonobank,
  monobankOutcome,
  monobankRefundOutcome,
} from "./monobank.js";

const TOKEN = "test-merchant-token";

const keys = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });

const foreign = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });

const publicKeyPem = keys.publicKey.export({
  type: "spki",
  format: "pem",
}) as string;

const publicKeyBase64 = Buffer.from(publicKeyPem, "utf8").toString("base64");

function sign(body: string, key = keys.privateKey): string {
  return crypto
    .sign("SHA256", Buffer.from(body, "utf8"), key)
    .toString("base64");
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

function stubbed(reply: unknown, status = 200) {
  const calls: Call[] = [];

  const provider = createMonobank(
    { token: TOKEN, publicKey: publicKeyBase64 },
    {
      fetch: ((url: string, init: RequestInit) => {
        calls.push({
          url,
          method: String(init.method),
          headers: init.headers as Record<string, string>,
          body: init.body
            ? (JSON.parse(String(init.body)) as Record<string, unknown>)
            : null,
        });

        return Promise.resolve({
          ok: status >= 200 && status < 300,
          status,
          text: () => Promise.resolve(JSON.stringify(reply)),
        });
      }) as unknown as typeof globalThis.fetch,
    },
  );

  return { provider, calls };
}

describe("monobankOutcome", () => {
  it("reads a settled payment as succeeded", () => {
    expect(monobankOutcome("success")).toBe("succeeded");
  });

  it("reads the states that are still moving as pending", () => {
    expect(monobankOutcome("created")).toBe("pending");
    expect(monobankOutcome("processing")).toBe("pending");
    expect(monobankOutcome("hold")).toBe("pending");
  });

  it("reads anything else as failed", () => {
    expect(monobankOutcome("failure")).toBe("failed");
    expect(monobankOutcome("expired")).toBe("failed");
    expect(monobankOutcome(undefined)).toBe("failed");
  });
});

describe("monobankRefundOutcome", () => {
  it("reads a completed cancellation as refunded", () => {
    expect(monobankRefundOutcome("success")).toBe("refunded");
    expect(monobankRefundOutcome("reversed")).toBe("refunded");
  });

  it("waits while it is processing", () => {
    expect(monobankRefundOutcome("processing")).toBe("pending");
  });

  it("reads a refused cancellation as failed", () => {
    expect(monobankRefundOutcome("failure")).toBe("failed");
  });
});

describe("createSetupCheckout", () => {
  it("asks for the card to be saved and returns the page", async () => {
    const { provider, calls } = stubbed({
      invoiceId: "p2_abc",
      pageUrl: "https://pay.mbnk.biz/p2_abc",
    });

    const session = await provider.createSetupCheckout({
      reference: "sub_1",
      amountMinor: 4990,
      currency: "UAH",
      description: "Pro, monthly",
      returnUrl: "https://example.com/done",
      webhookUrl: "https://example.com/hook",
      customerRef: "customer-9",
    });

    expect(session).toEqual({
      redirectUrl: "https://pay.mbnk.biz/p2_abc",
      providerRef: "p2_abc",
    });

    expect(calls[0]?.url).toBe(
      "https://api.monobank.ua/api/merchant/invoice/create",
    );
    expect(calls[0]?.headers["X-Token"]).toBe(TOKEN);
    expect(calls[0]?.body).toMatchObject({
      amount: 4990,
      ccy: 980,
      redirectUrl: "https://example.com/done",
      webHookUrl: "https://example.com/hook",
      saveCardData: { saveCard: true, walletId: "customer-9" },
    });
  });

  it("sends the amount in minor units without converting it", async () => {
    const { provider, calls } = stubbed({ invoiceId: "i", pageUrl: "u" });

    await provider.createSetupCheckout({
      reference: "sub_1",
      amountMinor: 100,
      currency: "USD",
      description: "d",
      returnUrl: "r",
      webhookUrl: "w",
    });

    expect(calls[0]?.body).toMatchObject({ amount: 100, ccy: 840 });
  });

  it("refuses a currency it has no ISO number for", async () => {
    const { provider } = stubbed({ invoiceId: "i", pageUrl: "u" });

    await expect(
      provider.createSetupCheckout({
        reference: "sub_1",
        amountMinor: 100,
        currency: "XYZ",
        description: "d",
        returnUrl: "r",
        webhookUrl: "w",
      }),
    ).rejects.toThrow(/ISO 4217/);
  });

  it("throws when monobank returns no page", async () => {
    const { provider } = stubbed({ invoiceId: "i" });

    await expect(
      provider.createSetupCheckout({
        reference: "sub_1",
        amountMinor: 100,
        currency: "UAH",
        description: "d",
        returnUrl: "r",
        webhookUrl: "w",
      }),
    ).rejects.toThrow(/checkout page/);
  });
});

describe("charge", () => {
  it("charges the stored token as a merchant-initiated payment", async () => {
    const { provider, calls } = stubbed({
      invoiceId: "p2_next",
      status: "success",
    });

    const result = await provider.charge({
      reference: "sub_1_2",
      amountMinor: 4990,
      currency: "UAH",
      description: "Pro, monthly",
      token: "card-token",
    });

    expect(result).toMatchObject({
      outcome: "succeeded",
      providerRef: "p2_next",
    });

    expect(calls[0]?.url).toBe(
      "https://api.monobank.ua/api/merchant/wallet/payment",
    );
    expect(calls[0]?.body).toMatchObject({
      cardToken: "card-token",
      amount: 4990,
      ccy: 980,
      initiationKind: "merchant",
    });
  });

  it("reports a decline with its reason", async () => {
    const { provider } = stubbed({
      invoiceId: "p2_next",
      status: "failure",
      failureReason: "insufficient funds",
    });

    const result = await provider.charge({
      reference: "sub_1_2",
      amountMinor: 4990,
      currency: "UAH",
      description: "d",
      token: "card-token",
    });

    expect(result).toMatchObject({
      outcome: "failed",
      failureCode: "insufficient funds",
    });
  });

  it("keeps a 3DS challenge as pending rather than losing it", async () => {
    const { provider } = stubbed({
      invoiceId: "p2_next",
      status: "processing",
      tdsUrl: "https://3ds.example/challenge",
    });

    const result = await provider.charge({
      reference: "sub_1_2",
      amountMinor: 4990,
      currency: "UAH",
      description: "d",
      token: "card-token",
    });

    expect(result.outcome).toBe("pending");
    expect(result.raw?.["tdsUrl"]).toBe("https://3ds.example/challenge");
  });

  it("throws when monobank refuses the request", async () => {
    const { provider } = stubbed({ errText: "invalid token" }, 403);

    await expect(
      provider.charge({
        reference: "sub_1_2",
        amountMinor: 4990,
        currency: "UAH",
        description: "d",
        token: "card-token",
      }),
    ).rejects.toThrow(/Monobank answered 403/);
  });
});

describe("refund", () => {
  it("cancels the invoice it is given", async () => {
    const { provider, calls } = stubbed({ status: "success" });

    const result = await provider.refund({
      reference: "sub_1_2",
      providerRef: "p2_next",
      amountMinor: 4990,
      currency: "UAH",
      reason: "customer asked",
    });

    expect(result).toMatchObject({
      outcome: "refunded",
      providerRef: "p2_next",
      amountMinor: 4990,
    });

    expect(calls[0]?.url).toBe(
      "https://api.monobank.ua/api/merchant/invoice/cancel",
    );
    expect(calls[0]?.body).toMatchObject({
      invoiceId: "p2_next",
      amount: 4990,
      extRef: "customer asked",
    });
  });

  it("falls back to the reference when no provider ref is given", async () => {
    const { provider, calls } = stubbed({ status: "processing" });

    const result = await provider.refund({
      reference: "p2_only",
      amountMinor: 100,
      currency: "UAH",
    });

    expect(calls[0]?.body).toMatchObject({ invoiceId: "p2_only" });
    expect(result.outcome).toBe("pending");
  });
});

describe("status", () => {
  it("asks by invoice id", async () => {
    const { provider, calls } = stubbed({ status: "success" });

    const result = await provider.status("p2_abc");

    expect(calls[0]?.url).toBe(
      "https://api.monobank.ua/api/merchant/invoice/status?invoiceId=p2_abc",
    );
    expect(result.outcome).toBe("succeeded");
  });
});

describe("cancelRecurring", () => {
  it("removes the saved card", async () => {
    const { provider, calls } = stubbed({});

    const result = await provider.cancelRecurring("card-token");

    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toBe(
      "https://api.monobank.ua/api/merchant/wallet/card?cardToken=card-token",
    );
    expect(result.outcome).toBe("cancelled");
  });

  it("reports a refusal rather than throwing", async () => {
    const { provider } = stubbed({ err: "nope" }, 400);

    const result = await provider.cancelRecurring("card-token");

    expect(result.outcome).toBe("failed");
  });
});

describe("refreshPublicKey", () => {
  it("reads the key monobank publishes", async () => {
    const { provider, calls } = stubbed({ key: publicKeyBase64 });

    expect(await provider.refreshPublicKey()).toBe(publicKeyBase64);
    expect(calls[0]?.url).toBe("https://api.monobank.ua/api/merchant/pubkey");
  });

  it("throws when no key comes back", async () => {
    const { provider } = stubbed({});

    await expect(provider.refreshPublicKey()).rejects.toThrow(/public key/);
  });
});

describe("verifyWebhook", () => {
  const invoice = {
    invoiceId: "p2_abc",
    status: "success",
    amount: 4990,
    ccy: 980,
    reference: "sub_1",
    modifiedDate: "2026-01-01T00:00:00Z",
    walletData: { cardToken: "card-token", walletId: "customer-9" },
    paymentInfo: { maskedPan: "444444******4444", paymentSystem: "visa" },
  };

  const body = JSON.stringify(invoice);

  it("accepts a webhook monobank signed", () => {
    const { provider } = stubbed({});

    const envelope = provider.verifyWebhook(body, { "x-sign": sign(body) });

    expect(envelope).toMatchObject({
      eventId: "p2_abc:2026-01-01T00:00:00Z",
      reference: "sub_1",
      providerRef: "p2_abc",
      outcome: "succeeded",
      amountMinor: 4990,
      card: { token: "card-token", brand: "visa", last4: "4444" },
    });
  });

  it("keeps the token out of the stored payload", () => {
    const { provider } = stubbed({});

    const envelope = provider.verifyWebhook(body, { "x-sign": sign(body) });

    expect(JSON.stringify(envelope?.payload)).not.toContain("card-token");
  });

  it("reads the signature from a fetch Headers object", () => {
    const { provider } = stubbed({});

    const headers = new Headers({ "X-Sign": sign(body) });

    expect(provider.verifyWebhook(body, headers)).not.toBeNull();
  });

  it("refuses a tampered amount", () => {
    const { provider } = stubbed({});
    const tampered = body.replace('"amount":4990', '"amount":1');

    expect(
      provider.verifyWebhook(tampered, { "x-sign": sign(body) }),
    ).toBeNull();
  });

  it("refuses a tampered status", () => {
    const { provider } = stubbed({});
    const tampered = body.replace('"success"', '"failure"');

    expect(
      provider.verifyWebhook(tampered, { "x-sign": sign(body) }),
    ).toBeNull();
  });

  it("refuses a signature from another key", () => {
    const { provider } = stubbed({});

    expect(
      provider.verifyWebhook(body, {
        "x-sign": sign(body, foreign.privateKey),
      }),
    ).toBeNull();
  });

  it("refuses a webhook with no signature header", () => {
    const { provider } = stubbed({});

    expect(provider.verifyWebhook(body, {})).toBeNull();
    expect(provider.verifyWebhook(body)).toBeNull();
  });

  it("refuses a body that is not json", () => {
    const { provider } = stubbed({});
    const junk = "not json";

    expect(provider.verifyWebhook(junk, { "x-sign": sign(junk) })).toBeNull();
  });

  it("reads a reversal as a refund", () => {
    const { provider } = stubbed({});
    const reversed = JSON.stringify({ ...invoice, status: "reversed" });

    expect(
      provider.verifyWebhook(reversed, { "x-sign": sign(reversed) })?.outcome,
    ).toBe("refunded");
  });

  it("carries the failure reason through", () => {
    const { provider } = stubbed({});
    const failed = JSON.stringify({
      ...invoice,
      status: "failure",
      failureReason: "do not honour",
    });

    expect(
      provider.verifyWebhook(failed, { "x-sign": sign(failed) }),
    ).toMatchObject({ outcome: "failed", failureCode: "do not honour" });
  });

  it("gives each status change its own event id", () => {
    const { provider } = stubbed({});
    const later = JSON.stringify({
      ...invoice,
      modifiedDate: "2026-01-01T00:05:00Z",
    });

    const first = provider.verifyWebhook(body, { "x-sign": sign(body) });
    const second = provider.verifyWebhook(later, { "x-sign": sign(later) });

    expect(first?.eventId).not.toBe(second?.eventId);
  });

  it("says so rather than guessing when it has no public key", () => {
    const provider = createMonobank({ token: TOKEN });

    expect(() =>
      provider.verifyWebhook(body, { "x-sign": sign(body) }),
    ).toThrow(/refreshPublicKey/);
  });
});
