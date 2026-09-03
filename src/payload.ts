export function text(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return fallback;
}

export function numeric(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : fallback;
  }

  return fallback;
}

export function toMajorUnits(amountMinor: number): number {
  return Number((amountMinor / 100).toFixed(2));
}

export function toMinorUnits(amountMajor: number): number {
  return Math.round(amountMajor * 100);
}

export function last4Of(cardPan: string): string | undefined {
  const digits = cardPan.replace(/\D/g, "");

  return digits.length >= 4 ? digits.slice(-4) : undefined;
}

const TOKEN_FIELDS = ["recToken", "card_token", "cardToken", "token"];

const REDACTED = "[redacted]";

export function redactTokens(
  payload: Record<string, unknown>,
  secrets: readonly string[] = [],
): Record<string, unknown> {
  const wanted = new Set(secrets.filter((secret) => secret.length > 0));

  const walk = (value: unknown, key?: string): unknown => {
    if (typeof value === "string") {
      const isNamed = key !== undefined && TOKEN_FIELDS.includes(key);

      return isNamed || wanted.has(value) ? REDACTED : value;
    }

    if (Array.isArray(value)) {
      return value.map((entry) => walk(entry));
    }

    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(
          ([name, entry]) => [name, walk(entry, name)],
        ),
      );
    }

    return value;
  };

  return walk(payload) as Record<string, unknown>;
}

export function toBuffer(body: Buffer | string): Buffer {
  return Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
}
