import { last4Of, numeric, text, toBuffer, toMajorUnits } from "./payload.js";
import {
  CancelResult,
  ChargeOutcome,
  ChargeRequest,
  ChargeResult,
  ProviderOptions,
  RecurringProvider,
  RefundOutcome,
  RefundRequest,
  RefundResult,
  SetupRequest,
  SetupSession,
  StoredCard,
  WebhookEnvelope,
  WebhookOutcome,
} from "./types.js";
import {
  signAcknowledgement,
  signCallback,
  signPurchase,
  signRefund,
} from "./wayforpay-signature.js";

const API_URL = "https://api.wayforpay.com/api";

const REGULAR_API_URL = "https://api.wayforpay.com/regularApi";

const DEFAULT_TIMEOUT_MS = 15_000;

const APPROVED = new Set(["Approved"]);

const PENDING = new Set(["InProcessing", "WaitingAuthComplete", "Pending"]);

const REFUNDED = new Set(["Refunded", "Voided"]);

const REFUND_DECLINED = new Set(["Declined"]);

const REGULAR_API_OK = 4100;

export interface WayForPayCredentials {
  merchantAccount: string;
  merchantSecret: string;
  merchantDomain: string;
}

interface WayForPayResponse {
  orderReference?: string;
  transactionStatus?: string;
  reasonCode?: string | number;
  reason?: string;
  invoiceUrl?: string;
}

export function wayforpayOutcome(status: string | undefined): ChargeOutcome {
  if (status && APPROVED.has(status)) {
    return "succeeded";
  }

  if (status && PENDING.has(status)) {
    return "pending";
  }

  return "failed";
}

export function wayforpayRefundOutcome(
  status: string | undefined,
): RefundOutcome {
  if (status && REFUNDED.has(status)) {
    return "refunded";
  }

  if (status && REFUND_DECLINED.has(status)) {
    return "failed";
  }

  return "pending";
}

function wayforpayWebhookOutcome(status: string): WebhookOutcome {
  return REFUNDED.has(status) ? "refunded" : wayforpayOutcome(status);
}

class WayForPayProvider implements RecurringProvider {
  public readonly name = "wayforpay" as const;

  private readonly timeoutMs: number;
  private readonly request: typeof globalThis.fetch;

  constructor(
    private readonly credentials: WayForPayCredentials,
    options: ProviderOptions = {},
  ) {
    if (
      !credentials.merchantAccount ||
      !credentials.merchantSecret ||
      !credentials.merchantDomain
    ) {
      throw new Error(
        "WayForPay needs merchantAccount, merchantSecret and merchantDomain",
      );
    }

    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.request = options.fetch ?? globalThis.fetch;
  }

  private async call(
    body: Record<string, unknown>,
    url = API_URL,
  ): Promise<WayForPayResponse> {
    const response = await this.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`WayForPay answered ${response.status}`);
    }

    return (await response.json()) as WayForPayResponse;
  }

  private purchaseBody(
    reference: string,
    amountMinor: number,
    currency: string,
    description: string,
  ) {
    const { merchantAccount, merchantSecret, merchantDomain } =
      this.credentials;

    const amount = toMajorUnits(amountMinor);
    const orderDate = Math.floor(Date.now() / 1000);

    const fields = {
      merchantAccount,
      merchantDomainName: merchantDomain,
      orderReference: reference,
      orderDate,
      amount,
      currency,
      productName: [description],
      productCount: [1],
      productPrice: [amount],
    };

    return {
      apiVersion: 1,
      ...fields,
      merchantSignature: signPurchase(merchantSecret, fields),
    };
  }

  public async createSetupCheckout(
    request: SetupRequest,
  ): Promise<SetupSession> {
    const response = await this.call({
      transactionType: "CREATE_INVOICE",
      ...this.purchaseBody(
        request.reference,
        request.amountMinor,
        request.currency,
        request.description,
      ),
      recToken: "1",
      serviceUrl: request.webhookUrl,
      returnUrl: request.returnUrl,
    });

    if (!response.invoiceUrl) {
      throw new Error(
        `WayForPay returned no invoice URL: ${response.reason ?? "unknown"}`,
      );
    }

    return {
      redirectUrl: response.invoiceUrl,
      providerRef: response.orderReference ?? request.reference,
    };
  }

  public async charge(request: ChargeRequest): Promise<ChargeResult> {
    const response = await this.call({
      transactionType: "CHARGE",
      ...this.purchaseBody(
        request.reference,
        request.amountMinor,
        request.currency,
        request.description,
      ),
      recToken: request.token,
    });

    const outcome = wayforpayOutcome(response.transactionStatus);

    return {
      outcome,
      providerRef: response.orderReference ?? request.reference,
      ...(outcome === "failed"
        ? { failureCode: String(response.reasonCode ?? "declined") }
        : {}),
      raw: {
        transactionStatus: response.transactionStatus ?? null,
        reasonCode: response.reasonCode ?? null,
        reason: response.reason ?? null,
      },
    };
  }

  public async refund(request: RefundRequest): Promise<RefundResult> {
    const { merchantAccount, merchantSecret } = this.credentials;

    const amount = toMajorUnits(request.amountMinor);

    const response = await this.call({
      transactionType: "REFUND",
      apiVersion: 1,
      merchantAccount,
      orderReference: request.reference,
      amount,
      currency: request.currency,
      comment: request.reason ?? "Refund",
      merchantSignature: signRefund(merchantSecret, {
        merchantAccount,
        orderReference: request.reference,
        amount,
        currency: request.currency,
      }),
    });

    const outcome = wayforpayRefundOutcome(response.transactionStatus);

    return {
      outcome,
      providerRef: response.orderReference ?? request.reference,
      amountMinor: request.amountMinor,
      ...(outcome === "failed"
        ? { failureCode: String(response.reasonCode ?? "declined") }
        : {}),
      raw: {
        transactionStatus: response.transactionStatus ?? null,
        reasonCode: response.reasonCode ?? null,
        reason: response.reason ?? null,
      },
    };
  }

  public async status(providerRef: string): Promise<ChargeResult> {
    const { merchantAccount, merchantSecret } = this.credentials;

    const response = await this.call({
      transactionType: "STATUS",
      apiVersion: 1,
      merchantAccount,
      orderReference: providerRef,
      merchantSignature: signCallback(merchantSecret, {
        merchantAccount,
        orderReference: providerRef,
        amount: 0,
        currency: "",
        authCode: "",
        cardPan: "",
        transactionStatus: "",
        reasonCode: "",
      }),
    });

    return {
      outcome: wayforpayOutcome(response.transactionStatus),
      providerRef,
      raw: { transactionStatus: response.transactionStatus ?? null },
    };
  }

  public async cancelRecurring(providerRef: string): Promise<CancelResult> {
    const { merchantAccount, merchantSecret } = this.credentials;

    const response = await this.call(
      {
        requestType: "REMOVE",
        merchantAccount,
        merchantPassword: merchantSecret,
        orderReference: providerRef,
      },
      REGULAR_API_URL,
    );

    const reasonCode = numeric(response.reasonCode, -1);
    const outcome = reasonCode === REGULAR_API_OK ? "cancelled" : "failed";

    return {
      outcome,
      providerRef,
      ...(outcome === "failed"
        ? { failureCode: String(response.reasonCode ?? "unknown") }
        : {}),
      raw: {
        reasonCode: response.reasonCode ?? null,
        reason: response.reason ?? null,
      },
    };
  }

  public verifyWebhook(rawBody: Buffer | string): WebhookEnvelope | null {
    const { merchantAccount, merchantSecret } = this.credentials;

    let payload: Record<string, unknown>;

    try {
      payload = JSON.parse(toBuffer(rawBody).toString("utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      return null;
    }

    const orderReference = payload["orderReference"];
    const supplied = payload["merchantSignature"];

    if (typeof orderReference !== "string" || typeof supplied !== "string") {
      return null;
    }

    const expected = signCallback(merchantSecret, {
      merchantAccount,
      orderReference,
      amount: numeric(payload["amount"]),
      currency: text(payload["currency"]),
      authCode: text(payload["authCode"]),
      cardPan: text(payload["cardPan"]),
      transactionStatus: text(payload["transactionStatus"]),
      reasonCode: text(payload["reasonCode"]),
    });

    if (expected !== supplied) {
      return null;
    }

    const transactionStatus = text(payload["transactionStatus"]);
    const outcome = wayforpayWebhookOutcome(transactionStatus);
    const recToken = text(payload["recToken"]);
    const last4 = last4Of(text(payload["cardPan"]));
    const expMonth = numeric(payload["cardExpMonth"]);
    const expYear = numeric(payload["cardExpYear"]);

    const card: StoredCard | undefined =
      outcome === "succeeded" && recToken
        ? {
            token: recToken,
            ...(text(payload["cardType"])
              ? { brand: text(payload["cardType"]) }
              : {}),
            ...(last4 ? { last4 } : {}),
            ...(expMonth ? { expMonth } : {}),
            ...(expYear ? { expYear } : {}),
          }
        : undefined;

    const time = Math.floor(Date.now() / 1000);

    return {
      eventId: `${orderReference}:${transactionStatus}:${text(
        payload["processingDate"],
      )}`,
      reference: orderReference,
      providerRef: orderReference,
      outcome,
      ...(outcome === "failed"
        ? { failureCode: text(payload["reasonCode"], "declined") }
        : {}),
      ...(payload["amount"] === undefined
        ? {}
        : { amountMinor: Math.round(numeric(payload["amount"]) * 100) }),
      ...(card ? { card } : {}),
      payload,
      acknowledgement: {
        orderReference,
        status: "accept",
        time,
        signature: signAcknowledgement(
          merchantSecret,
          orderReference,
          "accept",
          time,
        ),
      },
    };
  }
}

export function createWayForPay(
  credentials: WayForPayCredentials,
  options?: ProviderOptions,
): RecurringProvider {
  return new WayForPayProvider(credentials, options);
}
