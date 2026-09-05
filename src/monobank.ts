import { currencyNumber } from "./currency.js";
import {
  MONOBANK_SIGNATURE_HEADER,
  readHeader,
  verifyMonobankSignature,
} from "./monobank-signature.js";
import { last4Of, numeric, redactTokens, text, toBuffer } from "./payload.js";
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
  WebhookHeaders,
  WebhookOutcome,
} from "./types.js";

const API_BASE = "https://api.monobank.ua";

const DEFAULT_TIMEOUT_MS = 15_000;

const SUCCESS = new Set(["success"]);

const PENDING = new Set(["created", "processing", "hold", "pending"]);

const REVERSED = new Set(["reversed"]);

export interface MonobankCredentials {
  token: string;
  publicKey?: string;
  baseUrl?: string;
}

interface MonobankInvoice {
  invoiceId?: string;
  pageUrl?: string;
  status?: string;
  failureReason?: string;
  errCode?: string;
  errorDescription?: string;
  amount?: number;
  ccy?: number;
  finalAmount?: number;
  reference?: string;
  createdDate?: string;
  modifiedDate?: string;
  tdsUrl?: string;
  walletData?: { cardToken?: string; walletId?: string; status?: string };
  paymentInfo?: { maskedPan?: string; paymentSystem?: string };
}

export function monobankOutcome(status: string | undefined): ChargeOutcome {
  if (status && SUCCESS.has(status)) {
    return "succeeded";
  }

  if (status && PENDING.has(status)) {
    return "pending";
  }

  return "failed";
}

export function monobankRefundOutcome(
  status: string | undefined,
): RefundOutcome {
  if (status && (SUCCESS.has(status) || REVERSED.has(status))) {
    return "refunded";
  }

  if (status === "processing") {
    return "pending";
  }

  return "failed";
}

function monobankWebhookOutcome(status: string | undefined): WebhookOutcome {
  if (status && REVERSED.has(status)) {
    return "refunded";
  }

  return monobankOutcome(status);
}

function cardOf(invoice: MonobankInvoice): StoredCard | undefined {
  const token = invoice.walletData?.cardToken;

  if (!token) {
    return undefined;
  }

  const maskedPan = invoice.paymentInfo?.maskedPan;
  const last4 = maskedPan ? last4Of(maskedPan) : undefined;

  return {
    token,
    ...(invoice.paymentInfo?.paymentSystem
      ? { brand: invoice.paymentInfo.paymentSystem }
      : {}),
    ...(last4 ? { last4 } : {}),
  };
}

class MonobankProvider implements RecurringProvider {
  public readonly name = "monobank" as const;

  private readonly timeoutMs: number;
  private readonly request: typeof globalThis.fetch;
  private readonly baseUrl: string;
  private publicKey: string | undefined;

  constructor(
    private readonly credentials: MonobankCredentials,
    options: ProviderOptions = {},
  ) {
    if (!credentials.token) {
      throw new Error("Monobank needs a merchant token");
    }

    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.request = options.fetch ?? globalThis.fetch;
    this.baseUrl = credentials.baseUrl ?? API_BASE;
    this.publicKey = credentials.publicKey;
  }

  private async call<T>(
    path: string,
    init: { method: string; body?: unknown; query?: Record<string, string> },
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);

    for (const [key, value] of Object.entries(init.query ?? {})) {
      url.searchParams.set(key, value);
    }

    const response = await this.request(url.toString(), {
      method: init.method,
      headers: {
        "X-Token": this.credentials.token,
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const raw = await response.text();

    if (!response.ok) {
      throw new Error(
        `Monobank answered ${response.status}${raw ? `: ${raw}` : ""}`,
      );
    }

    return (raw ? JSON.parse(raw) : {}) as T;
  }

  public async refreshPublicKey(): Promise<string> {
    const response = await this.call<{ key?: string }>("/api/merchant/pubkey", {
      method: "GET",
    });

    if (!response.key) {
      throw new Error("Monobank did not return a webhook public key");
    }

    this.publicKey = response.key;

    return response.key;
  }

  public async createSetupCheckout(
    request: SetupRequest,
  ): Promise<SetupSession> {
    const response = await this.call<MonobankInvoice>(
      "/api/merchant/invoice/create",
      {
        method: "POST",
        body: {
          amount: request.amountMinor,
          ccy: currencyNumber(request.currency),
          merchantPaymInfo: {
            reference: request.reference,
            destination: request.description,
          },
          redirectUrl: request.returnUrl,
          webHookUrl: request.webhookUrl,
          paymentType: "debit",
          saveCardData: {
            saveCard: true,
            ...(request.customerRef ? { walletId: request.customerRef } : {}),
          },
        },
      },
    );

    if (!response.pageUrl || !response.invoiceId) {
      throw new Error("Monobank did not return a checkout page");
    }

    return { redirectUrl: response.pageUrl, providerRef: response.invoiceId };
  }

  public async charge(request: ChargeRequest): Promise<ChargeResult> {
    const response = await this.call<MonobankInvoice>(
      "/api/merchant/wallet/payment",
      {
        method: "POST",
        body: {
          cardToken: request.token,
          amount: request.amountMinor,
          ccy: currencyNumber(request.currency),
          initiationKind: "merchant",
          merchantPaymInfo: {
            reference: request.reference,
            destination: request.description,
          },
          paymentType: "debit",
        },
      },
    );

    const outcome = monobankOutcome(response.status);

    return {
      outcome,
      providerRef: response.invoiceId ?? request.reference,
      ...(outcome === "failed"
        ? { failureCode: response.failureReason ?? "declined" }
        : {}),
      raw: {
        status: response.status ?? null,
        failureReason: response.failureReason ?? null,
        tdsUrl: response.tdsUrl ?? null,
      },
    };
  }

  public async refund(request: RefundRequest): Promise<RefundResult> {
    const invoiceId = request.providerRef ?? request.reference;

    const response = await this.call<MonobankInvoice>(
      "/api/merchant/invoice/cancel",
      {
        method: "POST",
        body: {
          invoiceId,
          amount: request.amountMinor,
          ...(request.reason ? { extRef: request.reason } : {}),
        },
      },
    );

    const outcome = monobankRefundOutcome(response.status);

    return {
      outcome,
      providerRef: invoiceId,
      amountMinor: request.amountMinor,
      ...(outcome === "failed"
        ? { failureCode: response.status ?? "declined" }
        : {}),
      raw: { status: response.status ?? null },
    };
  }

  public async status(providerRef: string): Promise<ChargeResult> {
    const response = await this.call<MonobankInvoice>(
      "/api/merchant/invoice/status",
      { method: "GET", query: { invoiceId: providerRef } },
    );

    const outcome = monobankOutcome(response.status);

    return {
      outcome,
      providerRef,
      ...(outcome === "failed"
        ? { failureCode: response.failureReason ?? "declined" }
        : {}),
      raw: {
        status: response.status ?? null,
        failureReason: response.failureReason ?? null,
      },
    };
  }

  public async cancelRecurring(providerRef: string): Promise<CancelResult> {
    try {
      await this.call<unknown>("/api/merchant/wallet/card", {
        method: "DELETE",
        query: { cardToken: providerRef },
      });

      return { outcome: "cancelled", providerRef };
    } catch (error) {
      return {
        outcome: "failed",
        providerRef,
        failureCode: error instanceof Error ? error.message : "failed",
      };
    }
  }

  public verifyWebhook(
    rawBody: Buffer | string,
    headers?: WebhookHeaders,
  ): WebhookEnvelope | null {
    if (!this.publicKey) {
      throw new Error(
        "Monobank has no webhook public key yet. Pass publicKey, or await provider.refreshPublicKey() first.",
      );
    }

    const signature = readHeader(headers, MONOBANK_SIGNATURE_HEADER);

    if (!signature) {
      return null;
    }

    const body = toBuffer(rawBody);

    if (!verifyMonobankSignature(this.publicKey, body, signature)) {
      return null;
    }

    let invoice: MonobankInvoice;

    try {
      invoice = JSON.parse(body.toString("utf8")) as MonobankInvoice;
    } catch {
      return null;
    }

    if (!invoice.invoiceId) {
      return null;
    }

    const outcome = monobankWebhookOutcome(invoice.status);
    const card = cardOf(invoice);
    const amount = numeric(invoice.amount, Number.NaN);

    return {
      eventId: `${invoice.invoiceId}:${text(invoice.modifiedDate, "0")}`,
      reference: text(invoice.reference, invoice.invoiceId),
      providerRef: invoice.invoiceId,
      outcome,
      ...(outcome === "failed"
        ? {
            failureCode: text(
              invoice.failureReason ?? invoice.errCode,
              "declined",
            ),
          }
        : {}),
      ...(Number.isFinite(amount) ? { amountMinor: amount } : {}),
      ...(card ? { card } : {}),
      payload: redactTokens(invoice as unknown as Record<string, unknown>),
    };
  }
}

export function createMonobank(
  credentials: MonobankCredentials,
  options: ProviderOptions = {},
): MonobankProvider {
  return new MonobankProvider(credentials, options);
}
