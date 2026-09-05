const ISO_NUMERIC: Record<string, number> = {
  UAH: 980,
  USD: 840,
  EUR: 978,
  GBP: 826,
  PLN: 985,
  CZK: 203,
  CHF: 756,
  CAD: 124,
};

const ISO_ALPHA = new Map(
  Object.entries(ISO_NUMERIC).map(([alpha, numeric]) => [numeric, alpha]),
);

export function currencyNumber(currency: string): number {
  const trimmed = currency.trim();
  const asNumber = Number(trimmed);

  if (Number.isInteger(asNumber) && asNumber > 0) {
    return asNumber;
  }

  const code = ISO_NUMERIC[trimmed.toUpperCase()];

  if (code === undefined) {
    throw new Error(
      `No ISO 4217 number known for "${currency}". Pass the number instead.`,
    );
  }

  return code;
}

export function currencyAlpha(code: number): string {
  return ISO_ALPHA.get(code) ?? String(code);
}
