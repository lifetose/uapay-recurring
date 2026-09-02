export type ChargeOutcome = "succeeded" | "failed" | "pending";

export type ProviderName = "wayforpay" | "liqpay";

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

export interface WebhookEnvelope {
  eventId: string;
  reference: string;
  providerRef: string;
  outcome: ChargeOutcome;
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
  status(providerRef: string): Promise<ChargeResult>;
  cancelRecurring(providerRef: string): Promise<void>;

  verifyWebhook(rawBody: Buffer | string): WebhookEnvelope | null;
}

export interface ProviderOptions {
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}
