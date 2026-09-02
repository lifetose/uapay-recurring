import crypto from "node:crypto";

export function addMonths(from: Date, months: number): Date {
  const next = new Date(from.getTime());
  const day = next.getUTCDate();

  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + months);

  const lastDay = new Date(
    Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
  ).getUTCDate();

  next.setUTCDate(Math.min(day, lastDay));

  return next;
}

export function nextPeriodStart(
  currentPeriodEnd: Date | undefined,
  now = new Date(),
): Date {
  if (!currentPeriodEnd || currentPeriodEnd.getTime() < now.getTime()) {
    return now;
  }

  return currentPeriodEnd;
}

export function paymentReference(prefix = "pay"): string {
  return `${prefix}-${Date.now().toString(36)}-${crypto
    .randomBytes(6)
    .toString("hex")}`;
}
