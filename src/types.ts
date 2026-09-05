export type ChargeOutcome = "succeeded" | "failed" | "pending";

export type RefundOutcome = "refunded" | "failed" | "pending";

export type WebhookOutcome = ChargeOutcome | "refunded";

export type ProviderName = "wayforpay" | "liqpay" | "monobank";

export type WebhookHeaders =
  | { get(name: string): string | null }
  | Record<string, string | string[] | undefined>;

export interface StoredCard {
  token: string;
  brand?: string;
  last4?: string;
  expMonth?: number;
  expYear?: number;
}

export interface SetupRequest {
  reference: string;
  amountMinor: number;
  currency: string;
  description: string;
  returnUrl: string;
  webhookUrl: string;
  customerRef?: string;
}

export interface SetupSession {
  redirectUrl: string;
  providerRef: string;
}

export interface ChargeRequest {
  reference: string;
  amountMinor: number;
  currency: string;
  description: string;
  token: string;
}

export interface ChargeResult {
  outcome: ChargeOutcome;
  providerRef: string;
  failureCode?: string;
  raw?: Record<string, unknown>;
}

export type CancelOutcome = "cancelled" | "failed";

export interface CancelResult {
  outcome: CancelOutcome;
  providerRef: string;
  failureCode?: string;
  raw?: Record<string, unknown>;
}

export interface RefundRequest {
  reference: string;
  amountMinor: number;
  currency: string;
  reason?: string;
  providerRef?: string;
}

export interface RefundResult {
  outcome: RefundOutcome;
  providerRef: string;
  amountMinor: number;
  failureCode?: string;
  raw?: Record<string, unknown>;
}

export interface WebhookEnvelope {
  eventId: string;
  reference: string;
  providerRef: string;
  outcome: WebhookOutcome;
  failureCode?: string;
  amountMinor?: number;
  card?: StoredCard;
  payload: Record<string, unknown>;
  acknowledgement?: unknown;
}

export interface RecurringProvider {
  readonly name: ProviderName;

  createSetupCheckout(request: SetupRequest): Promise<SetupSession>;
  charge(request: ChargeRequest): Promise<ChargeResult>;
  refund(request: RefundRequest): Promise<RefundResult>;
  status(providerRef: string): Promise<ChargeResult>;
  cancelRecurring(providerRef: string): Promise<CancelResult>;

  verifyWebhook(
    rawBody: Buffer | string,
    headers?: WebhookHeaders,
  ): WebhookEnvelope | null;
}

export interface ProviderOptions {
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}
