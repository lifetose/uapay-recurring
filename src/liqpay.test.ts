import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import { createLiqPay, liqpayOutcome, liqpayRefundOutcome } from "./liqpay.js";
import {
  decodeLiqPayData,
  encodeLiqPayData,
  liqpaySignature,
} from "./liqpay-signature.js";

const PUBLIC_KEY = "i00000000";
const PRIVATE_KEY = "a4825234f4bae72a0be04eafe9e8e2bada209255";

const provider = createLiqPay({
  publicKey: PUBLIC_KEY,
  privateKey: PRIVATE_KEY,
});

function callback(overrides: Record<string, unknown> = {}, key = PRIVATE_KEY) {
  const data = encodeLiqPayData({
    status: "success",
    order_id: "pay-abc-0123456789ab",
    payment_id: 1_000_000_1,
    amount: 4.99,
    currency: "USD",
    card_token: "card-token-1",
    sender_card_mask2: "414963*36",
    sender_card_type: "visa",
    sender_card_exp_month: 11,
    sender_card_exp_year: 2030,
    end_date: 1_415_379_863,
    ...overrides,
  });

  return Buffer.from(
    new URLSearchParams({
      data,
      signature: liqpaySignature(key, data),
    }).toString(),
    "utf8",
  );
}

describe("liqpaySignature", () => {
  it("is base64 of sha1 over key + data + key", () => {
    const data = encodeLiqPayData({ action: "pay", amount: 1 });
    const expected = crypto
      .createHash("sha1")
      .update(PRIVATE_KEY + data + PRIVATE_KEY, "utf8")
      .digest("base64");

    expect(liqpaySignature(PRIVATE_KEY, data)).toBe(expected);
  });

  it("changes when the data changes", () => {
    expect(
      liqpaySignature(PRIVATE_KEY, encodeLiqPayData({ amount: 1 })),
    ).not.toBe(liqpaySignature(PRIVATE_KEY, encodeLiqPayData({ amount: 2 })));
  });

  it("changes when the key changes", () => {
    const data = encodeLiqPayData({ amount: 1 });

    expect(liqpaySignature(PRIVATE_KEY, data)).not.toBe(
      liqpaySignature("other", data),
    );
  });
});

describe("encodeLiqPayData", () => {
  it("round-trips through base64", () => {
    const payload = { action: "pay", amount: 499, description: "Тариф" };

    expect(decodeLiqPayData(encodeLiqPayData(payload))).toEqual(payload);
  });

  it("returns null for data that is not encoded JSON", () => {
    expect(decodeLiqPayData("not-base64-json")).toBeNull();
  });
});

describe("liqpayOutcome", () => {
  it.each(["success", "subscribed", "sandbox"])(
    "treats %s as succeeded",
    (status) => {
      expect(liqpayOutcome(status)).toBe("succeeded");
    },
  );

  it.each(["processing", "wait_secure", "hold_wait"])(
    "treats %s as pending",
    (status) => {
      expect(liqpayOutcome(status)).toBe("pending");
    },
  );

  it.each(["failure", "error", "reversed", undefined])(
    "treats %s as failed",
    (status) => {
      expect(liqpayOutcome(status)).toBe("failed");
    },
  );
});

describe("createLiqPay", () => {
  it("refuses to build without both keys", () => {
    expect(() =>
      createLiqPay({ publicKey: PUBLIC_KEY, privateKey: "" }),
    ).toThrow(/privateKey/);
  });
});

describe("verifyWebhook", () => {
  it("accepts a correctly signed callback", () => {
    const envelope = provider.verifyWebhook(callback());

    expect(envelope?.outcome).toBe("succeeded");
    expect(envelope?.reference).toBe("pay-abc-0123456789ab");
    expect(envelope?.amountMinor).toBe(499);
  });

  it("carries the card token through", () => {
    expect(provider.verifyWebhook(callback())?.card).toEqual({
      token: "card-token-1",
      brand: "visa",
      last4: "6336",
      expMonth: 11,
      expYear: 2030,
    });
  });

  it("rejects a callback signed with the wrong key", () => {
    expect(provider.verifyWebhook(callback({}, "other"))).toBeNull();
  });

  it("rejects a body with no signature", () => {
    expect(provider.verifyWebhook(Buffer.from("data=abc", "utf8"))).toBeNull();
  });

  it("rejects a callback with no order id", () => {
    expect(provider.verifyWebhook(callback({ order_id: "" }))).toBeNull();
  });

  it("keeps no card when the payment failed", () => {
    const envelope = provider.verifyWebhook(
      callback({ status: "failure", err_code: "limit" }),
    );

    expect(envelope?.outcome).toBe("failed");
    expect(envelope?.card).toBeUndefined();
    expect(envelope?.failureCode).toBe("limit");
  });
});

describe("createSetupCheckout", () => {
  it("builds a signed checkout URL that asks for a token", async () => {
    const session = await provider.createSetupCheckout({
      reference: "pay-1",
      amountMinor: 499,
      currency: "USD",
      description: "Subscription",
      returnUrl: "https://example.com/done",
      webhookUrl: "https://example.com/hook",
    });

    const url = new URL(session.redirectUrl);
    const data = url.searchParams.get("data")!;

    expect(url.origin + url.pathname).toBe(
      "https://www.liqpay.ua/api/3/checkout",
    );
    expect(url.searchParams.get("signature")).toBe(
      liqpaySignature(PRIVATE_KEY, data),
    );
    expect(decodeLiqPayData(data)).toMatchObject({
      action: "pay",
      recurringbytoken: "1",
      amount: 4.99,
      server_url: "https://example.com/hook",
    });
  });
});

function stubbed(
  reply: Record<string, unknown>,
  bodies: Record<string, unknown>[] = [],
) {
  return createLiqPay(
    { publicKey: PUBLIC_KEY, privateKey: PRIVATE_KEY },
    {
      fetch: ((_url: string, init: RequestInit) => {
        const form = new URLSearchParams(String(init.body));

        bodies.push(decodeLiqPayData(form.get("data")!)!);

        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(reply),
        });
      }) as unknown as typeof globalThis.fetch,
    },
  );
}

describe("liqpayRefundOutcome", () => {
  it("treats reversed as refunded", () => {
    expect(liqpayRefundOutcome("reversed")).toBe("refunded");
  });

  it.each(["failure", "error"])("treats %s as failed", (status) => {
    expect(liqpayRefundOutcome(status)).toBe("failed");
  });

  it.each(["wait_reserve", "something new", undefined])(
    "leaves %s pending rather than inviting a second refund",
    (status) => {
      expect(liqpayRefundOutcome(status)).toBe("pending");
    },
  );
});

describe("refund", () => {
  it("sends a signed refund for the order", async () => {
    const bodies: Record<string, unknown>[] = [];

    const result = await stubbed(
      { status: "reversed", payment_id: 10_000_001 },
      bodies,
    ).refund({ reference: "pay-1", amountMinor: 499, currency: "USD" });

    expect(bodies[0]).toMatchObject({
      action: "refund",
      order_id: "pay-1",
      amount: 4.99,
      version: "3",
      public_key: PUBLIC_KEY,
    });

    expect(result.outcome).toBe("refunded");
    expect(result.providerRef).toBe("10000001");
    expect(result.amountMinor).toBe(499);
  });

  it("refunds part of a payment when asked for less than the whole", async () => {
    const bodies: Record<string, unknown>[] = [];

    await stubbed({ status: "reversed" }, bodies).refund({
      reference: "pay-1",
      amountMinor: 200,
      currency: "USD",
    });

    expect(bodies[0]).toMatchObject({ amount: 2 });
  });

  it("reports a refused refund with its error code", async () => {
    const result = await stubbed({
      status: "error",
      err_code: "payment_err_status",
    }).refund({ reference: "pay-1", amountMinor: 499, currency: "USD" });

    expect(result.outcome).toBe("failed");
    expect(result.failureCode).toBe("payment_err_status");
  });

  it("holds wait_reserve as pending", async () => {
    const result = await stubbed({ status: "wait_reserve" }).refund({
      reference: "pay-1",
      amountMinor: 499,
      currency: "USD",
    });

    expect(result.outcome).toBe("pending");
  });
});

describe("verifyWebhook, refund callbacks", () => {
  it("reads reversed as a refund rather than a failed charge", () => {
    const envelope = provider.verifyWebhook(callback({ status: "reversed" }));

    expect(envelope?.outcome).toBe("refunded");
    expect(envelope?.failureCode).toBeUndefined();
    expect(envelope?.card).toBeUndefined();
  });
});

describe("cancelRecurring", () => {
  it("reports an accepted unsubscribe", async () => {
    const bodies: Record<string, unknown>[] = [];

    const result = await stubbed(
      { status: "unsubscribed" },
      bodies,
    ).cancelRecurring("pay-1");

    expect(bodies[0]).toMatchObject({
      action: "unsubscribe",
      order_id: "pay-1",
    });
    expect(result.outcome).toBe("cancelled");
  });

  it("reports a refusal instead of silently succeeding", async () => {
    const result = await stubbed({
      status: "error",
      err_code: "order_id_empty",
    }).cancelRecurring("pay-1");

    expect(result.outcome).toBe("failed");
    expect(result.failureCode).toBe("order_id_empty");
  });
});
