import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import { createLiqPay, liqpayOutcome } from "./liqpay.js";
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
