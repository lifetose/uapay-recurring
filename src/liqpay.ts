import {
  decodeLiqPayData,
  encodeLiqPayData,
  liqpaySignature,
} from "./liqpay-signature.js";
import { last4Of, numeric, text, toBuffer, toMajorUnits } from "./payload.js";
import {
  ChargeOutcome,
  ChargeRequest,
  ChargeResult,
  ProviderOptions,
  RecurringProvider,
  SetupRequest,
  SetupSession,
  StoredCard,
  WebhookEnvelope,
} from "./types.js";

const API_URL = "https://www.liqpay.ua/api/request";

const CHECKOUT_URL = "https://www.liqpay.ua/api/3/checkout";

const API_VERSION = "3";

const DEFAULT_TIMEOUT_MS = 15_000;

const SUCCESS = new Set(["success", "subscribed", "sandbox"]);

const PENDING = new Set([
  "processing",
  "prepared",
  "wait_accept",
  "wait_secure",
  "wait_card",
  "hold_wait",
]);

export interface LiqPayCredentials {
  publicKey: string;
  privateKey: string;
}

interface LiqPayResponse {
  status?: string;
  payment_id?: string | number;
  order_id?: string;
  err_code?: string;
  err_description?: string;
}

export function liqpayOutcome(status: string | undefined): ChargeOutcome {
  if (status && SUCCESS.has(status)) {
    return "succeeded";
  }

  if (status && PENDING.has(status)) {
    return "pending";
  }

  return "failed";
}

class LiqPayProvider implements RecurringProvider {
  public readonly name = "liqpay" as const;

  private readonly timeoutMs: number;
  private readonly request: typeof globalThis.fetch;

  constructor(
    private readonly credentials: LiqPayCredentials,
    options: ProviderOptions = {},
  ) {
    if (!credentials.publicKey || !credentials.privateKey) {
      throw new Error("LiqPay needs publicKey and privateKey");
    }

    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.request = options.fetch ?? globalThis.fetch;
  }

  private async call(
    payload: Record<string, unknown>,
  ): Promise<LiqPayResponse> {
    const { publicKey, privateKey } = this.credentials;

    const data = encodeLiqPayData({
      ...payload,
      public_key: publicKey,
      version: API_VERSION,
    });

    const response = await this.request(API_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        data,
        signature: liqpaySignature(privateKey, data),
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`LiqPay answered ${response.status}`);
    }

    return (await response.json()) as LiqPayResponse;
  }

  public createSetupCheckout(request: SetupRequest): Promise<SetupSession> {
    const { publicKey, privateKey } = this.credentials;

    const data = encodeLiqPayData({
      public_key: publicKey,
      version: API_VERSION,
      action: "pay",
      amount: toMajorUnits(request.amountMinor),
      currency: request.currency,
      description: request.description,
      order_id: request.reference,
      recurringbytoken: "1",
      server_url: request.webhookUrl,
      result_url: request.returnUrl,
    });

    const url = new URL(CHECKOUT_URL);

    url.searchParams.set("data", data);
    url.searchParams.set("signature", liqpaySignature(privateKey, data));

    return Promise.resolve({
      redirectUrl: url.toString(),
      providerRef: request.reference,
    });
  }

  public async charge(request: ChargeRequest): Promise<ChargeResult> {
    const response = await this.call({
      action: "paytoken",
      amount: toMajorUnits(request.amountMinor),
      currency: request.currency,
      description: request.description,
      order_id: request.reference,
      card_token: request.token,
    });

    const outcome = liqpayOutcome(response.status);

    return {
      outcome,
      providerRef: String(
        response.payment_id ?? response.order_id ?? request.reference,
      ),
      ...(outcome === "failed"
        ? { failureCode: response.err_code ?? "declined" }
        : {}),
      raw: {
        status: response.status ?? null,
        errCode: response.err_code ?? null,
        errDescription: response.err_description ?? null,
      },
    };
  }

  public async status(providerRef: string): Promise<ChargeResult> {
    const response = await this.call({
      action: "status",
      order_id: providerRef,
    });

    return {
      outcome: liqpayOutcome(response.status),
      providerRef,
      raw: { status: response.status ?? null },
    };
  }

  public async cancelRecurring(providerRef: string): Promise<void> {
    await this.call({ action: "unsubscribe", order_id: providerRef });
  }

  public verifyWebhook(rawBody: Buffer | string): WebhookEnvelope | null {
    const { privateKey } = this.credentials;

    const form = new URLSearchParams(toBuffer(rawBody).toString("utf8"));

    const data = form.get("data");
    const supplied = form.get("signature");

    if (!data || !supplied) {
      return null;
    }

    if (liqpaySignature(privateKey, data) !== supplied) {
      return null;
    }

    const payload = decodeLiqPayData(data);

    if (!payload) {
      return null;
    }

    const reference = text(payload["order_id"]);

    if (!reference) {
      return null;
    }

    const status = text(payload["status"]);
    const outcome = liqpayOutcome(status);
    const cardToken = text(payload["card_token"]);
    const last4 = last4Of(text(payload["sender_card_mask2"]));
    const expMonth = numeric(payload["sender_card_exp_month"]);
    const expYear = numeric(payload["sender_card_exp_year"]);

    const card: StoredCard | undefined =
      outcome === "succeeded" && cardToken
        ? {
            token: cardToken,
            ...(text(payload["sender_card_type"])
              ? { brand: text(payload["sender_card_type"]) }
              : {}),
            ...(last4 ? { last4 } : {}),
            ...(expMonth ? { expMonth } : {}),
            ...(expYear ? { expYear } : {}),
          }
        : undefined;

    const providerRef = text(payload["payment_id"], reference);

    return {
      eventId: `${providerRef}:${status}:${text(payload["end_date"])}`,
      reference,
      providerRef,
      outcome,
      ...(outcome === "failed"
        ? { failureCode: text(payload["err_code"], "declined") }
        : {}),
      ...(payload["amount"] === undefined
        ? {}
        : { amountMinor: Math.round(numeric(payload["amount"]) * 100) }),
      ...(card ? { card } : {}),
      payload,
    };
  }
}

export function createLiqPay(
  credentials: LiqPayCredentials,
  options?: ProviderOptions,
): RecurringProvider {
  return new LiqPayProvider(credentials, options);
}
