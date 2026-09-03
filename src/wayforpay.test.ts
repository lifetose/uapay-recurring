import { describe, expect, it } from "vitest";

import {
  createWayForPay,
  wayforpayOutcome,
  wayforpayRefundOutcome,
} from "./wayforpay.js";
import { signCallback, signRefund } from "./wayforpay-signature.js";

const ACCOUNT = "test_merch_n1";
const SECRET = "flk3409refn54t54t*FNJRET";
const DOMAIN = "example.com";

const provider = createWayForPay({
  merchantAccount: ACCOUNT,
  merchantSecret: SECRET,
  merchantDomain: DOMAIN,
});

function stubbed(
  reply: Record<string, unknown>,
  calls: Record<string, unknown>[] = [],
) {
  return createWayForPay(
    {
      merchantAccount: ACCOUNT,
      merchantSecret: SECRET,
      merchantDomain: DOMAIN,
    },
    {
      fetch: ((_url: string, init: RequestInit) => {
        calls.push(JSON.parse(String(init.body)) as Record<string, unknown>);

        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(reply),
        });
      }) as unknown as typeof globalThis.fetch,
    },
  );
}

function callback(overrides: Record<string, unknown> = {}, secret = SECRET) {
  const payload = {
    merchantAccount: ACCOUNT,
    orderReference: "pay-abc-0123456789ab",
    amount: 4.99,
    currency: "USD",
    authCode: "54321",
    cardPan: "44**********4242",
    transactionStatus: "Approved",
    reasonCode: 1100,
    recToken: "rec-token-1",
    cardType: "Visa",
    cardExpMonth: 11,
    cardExpYear: 2030,
    processingDate: 1_415_379_863,
    ...overrides,
  };

  return Buffer.from(
    JSON.stringify({
      ...payload,
      merchantSignature: signCallback(secret, {
        merchantAccount: ACCOUNT,
        orderReference: String(payload.orderReference),
        amount: Number(payload.amount),
        currency: String(payload.currency),
        authCode: String(payload.authCode),
        cardPan: String(payload.cardPan),
        transactionStatus: String(payload.transactionStatus),
        reasonCode: String(payload.reasonCode),
      }),
    }),
    "utf8",
  );
}

describe("wayforpayOutcome", () => {
  it("treats Approved as succeeded", () => {
    expect(wayforpayOutcome("Approved")).toBe("succeeded");
  });

  it.each(["InProcessing", "WaitingAuthComplete", "Pending"])(
    "treats %s as pending",
    (status) => {
      expect(wayforpayOutcome(status)).toBe("pending");
    },
  );

  it.each(["Declined", "Expired", "Refunded", undefined])(
    "treats %s as failed",
    (status) => {
      expect(wayforpayOutcome(status)).toBe("failed");
    },
  );
});

describe("createWayForPay", () => {
  it("refuses to build without every credential", () => {
    expect(() =>
      createWayForPay({
        merchantAccount: ACCOUNT,
        merchantSecret: "",
        merchantDomain: DOMAIN,
      }),
    ).toThrow(/merchantSecret/);
  });
});

describe("verifyWebhook", () => {
  it("accepts a correctly signed callback", () => {
    const envelope = provider.verifyWebhook(callback());

    expect(envelope?.outcome).toBe("succeeded");
    expect(envelope?.reference).toBe("pay-abc-0123456789ab");
    expect(envelope?.amountMinor).toBe(499);
  });

  it("carries the recurring token and card details through", () => {
    expect(provider.verifyWebhook(callback())?.card).toEqual({
      token: "rec-token-1",
      brand: "Visa",
      last4: "4242",
      expMonth: 11,
      expYear: 2030,
    });
  });

  it("signs an acknowledgement the acquirer will accept", () => {
    expect(provider.verifyWebhook(callback())?.acknowledgement).toMatchObject({
      orderReference: "pay-abc-0123456789ab",
      status: "accept",
    });
  });

  it("rejects a callback whose amount was tampered with", () => {
    const forged = JSON.parse(callback().toString("utf8")) as Record<
      string,
      unknown
    >;

    forged.amount = 0.01;

    expect(
      provider.verifyWebhook(Buffer.from(JSON.stringify(forged), "utf8")),
    ).toBeNull();
  });

  it("rejects a callback whose status was tampered with", () => {
    const forged = JSON.parse(callback().toString("utf8")) as Record<
      string,
      unknown
    >;

    forged.transactionStatus = "Approved";
    forged.reasonCode = 1100;
    forged.amount = 4.99;
    forged.authCode = "00000";

    expect(
      provider.verifyWebhook(Buffer.from(JSON.stringify(forged), "utf8")),
    ).toBeNull();
  });

  it("rejects a callback signed with someone else's secret", () => {
    expect(provider.verifyWebhook(callback({}, "not-our-secret"))).toBeNull();
  });

  it("rejects a body that is not JSON", () => {
    expect(provider.verifyWebhook(Buffer.from("not json", "utf8"))).toBeNull();
  });

  it("reads a string body as well as a buffer", () => {
    expect(provider.verifyWebhook(callback().toString("utf8"))?.outcome).toBe(
      "succeeded",
    );
  });

  it("keeps no card when the transaction was declined", () => {
    const envelope = provider.verifyWebhook(
      callback({ transactionStatus: "Declined", reasonCode: 1101 }),
    );

    expect(envelope?.outcome).toBe("failed");
    expect(envelope?.card).toBeUndefined();
    expect(envelope?.failureCode).toBe("1101");
  });
});

describe("createSetupCheckout", () => {
  it("asks for a recurring token and returns the invoice URL", async () => {
    const calls: Record<string, unknown>[] = [];

    const withStub = createWayForPay(
      {
        merchantAccount: ACCOUNT,
        merchantSecret: SECRET,
        merchantDomain: DOMAIN,
      },
      {
        fetch: ((_url: string, init: RequestInit) => {
          calls.push(JSON.parse(String(init.body)) as Record<string, unknown>);

          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                invoiceUrl: "https://secure.wayforpay.com/invoice/x",
                orderReference: "pay-1",
              }),
          });
        }) as unknown as typeof globalThis.fetch,
      },
    );

    const session = await withStub.createSetupCheckout({
      reference: "pay-1",
      amountMinor: 499,
      currency: "USD",
      description: "Subscription",
      returnUrl: "https://example.com/done",
      webhookUrl: "https://example.com/hook",
    });

    expect(session.redirectUrl).toBe("https://secure.wayforpay.com/invoice/x");
    expect(calls[0]).toMatchObject({
      transactionType: "CREATE_INVOICE",
      recToken: "1",
      amount: 4.99,
      serviceUrl: "https://example.com/hook",
    });
  });

  it("refuses a response with no invoice URL", async () => {
    const withStub = createWayForPay(
      {
        merchantAccount: ACCOUNT,
        merchantSecret: SECRET,
        merchantDomain: DOMAIN,
      },
      {
        fetch: (() =>
          Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ reason: "merchant not found" }),
          })) as unknown as typeof globalThis.fetch,
      },
    );

    await expect(
      withStub.createSetupCheckout({
        reference: "pay-1",
        amountMinor: 499,
        currency: "USD",
        description: "Subscription",
        returnUrl: "https://example.com/done",
        webhookUrl: "https://example.com/hook",
      }),
    ).rejects.toThrow(/merchant not found/);
  });
});

describe("wayforpayRefundOutcome", () => {
  it.each(["Refunded", "Voided"])("treats %s as refunded", (status) => {
    expect(wayforpayRefundOutcome(status)).toBe("refunded");
  });

  it("treats Declined as failed", () => {
    expect(wayforpayRefundOutcome("Declined")).toBe("failed");
  });

  it.each(["InProcessing", "Something new", undefined])(
    "leaves %s pending rather than inviting a second refund",
    (status) => {
      expect(wayforpayRefundOutcome(status)).toBe("pending");
    },
  );
});

describe("refund", () => {
  it("signs the refund over merchantAccount, orderReference, amount, currency", async () => {
    const calls: Record<string, unknown>[] = [];

    const result = await stubbed(
      { transactionStatus: "Refunded", orderReference: "pay-1" },
      calls,
    ).refund({
      reference: "pay-1",
      amountMinor: 499,
      currency: "USD",
      reason: "Cancelled within fourteen days",
    });

    expect(calls[0]).toMatchObject({
      transactionType: "REFUND",
      orderReference: "pay-1",
      amount: 4.99,
      currency: "USD",
      comment: "Cancelled within fourteen days",
      merchantSignature: signRefund(SECRET, {
        merchantAccount: ACCOUNT,
        orderReference: "pay-1",
        amount: 4.99,
        currency: "USD",
      }),
    });

    expect(result.outcome).toBe("refunded");
    expect(result.amountMinor).toBe(499);
  });

  it("refunds part of a payment when asked for less than the whole", async () => {
    const calls: Record<string, unknown>[] = [];

    const result = await stubbed(
      { transactionStatus: "Refunded" },
      calls,
    ).refund({ reference: "pay-1", amountMinor: 200, currency: "USD" });

    expect(calls[0]).toMatchObject({ amount: 2 });
    expect(result.amountMinor).toBe(200);
  });

  it("reports a declined refund with its reason code", async () => {
    const result = await stubbed({
      transactionStatus: "Declined",
      reasonCode: 1108,
    }).refund({ reference: "pay-1", amountMinor: 499, currency: "USD" });

    expect(result.outcome).toBe("failed");
    expect(result.failureCode).toBe("1108");
  });

  it("holds an unrecognised status as pending", async () => {
    const result = await stubbed({ transactionStatus: "InProcessing" }).refund({
      reference: "pay-1",
      amountMinor: 499,
      currency: "USD",
    });

    expect(result.outcome).toBe("pending");
    expect(result.failureCode).toBeUndefined();
  });
});

describe("verifyWebhook, refund callbacks", () => {
  it.each(["Refunded", "Voided"])(
    "reads %s as a refund rather than a failed charge",
    (status) => {
      const envelope = provider.verifyWebhook(
        callback({ transactionStatus: status }),
      );

      expect(envelope?.outcome).toBe("refunded");
      expect(envelope?.failureCode).toBeUndefined();
    },
  );

  it("keeps no card on a refund callback", () => {
    expect(
      provider.verifyWebhook(callback({ transactionStatus: "Refunded" }))?.card,
    ).toBeUndefined();
  });
});

describe("cancelRecurring", () => {
  it("posts REMOVE to the regular payments endpoint, not the payments one", async () => {
    let seen = "";

    const withStub = createWayForPay(
      {
        merchantAccount: ACCOUNT,
        merchantSecret: SECRET,
        merchantDomain: DOMAIN,
      },
      {
        fetch: ((url: string) => {
          seen = url;

          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ reasonCode: 4100, reason: "ok" }),
          });
        }) as unknown as typeof globalThis.fetch,
      },
    );

    const result = await withStub.cancelRecurring("pay-1");

    expect(seen).toBe("https://api.wayforpay.com/regularApi");
    expect(result.outcome).toBe("cancelled");
  });

  it("reports a refusal instead of silently succeeding", async () => {
    const result = await stubbed({
      reasonCode: 4102,
      reason: "Order not found",
    }).cancelRecurring("pay-1");

    expect(result.outcome).toBe("failed");
    expect(result.failureCode).toBe("4102");
  });
});
