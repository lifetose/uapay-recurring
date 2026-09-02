import crypto from "node:crypto";

export type SignatureField = string | number | readonly (string | number)[];

export function wayforpaySignature(
  secret: string,
  fields: readonly SignatureField[],
): string {
  const flattened: (string | number)[] = [];

  for (const field of fields) {
    if (typeof field === "string" || typeof field === "number") {
      flattened.push(field);
    } else {
      flattened.push(...field);
    }
  }

  return crypto
    .createHmac("md5", secret)
    .update(flattened.join(";"), "utf8")
    .digest("hex");
}

export interface WayForPayPurchaseFields {
  merchantAccount: string;
  merchantDomainName: string;
  orderReference: string;
  orderDate: number;
  amount: number;
  currency: string;
  productName: readonly string[];
  productCount: readonly number[];
  productPrice: readonly number[];
}

export function signPurchase(
  secret: string,
  fields: WayForPayPurchaseFields,
): string {
  return wayforpaySignature(secret, [
    fields.merchantAccount,
    fields.merchantDomainName,
    fields.orderReference,
    fields.orderDate,
    fields.amount,
    fields.currency,
    fields.productName,
    fields.productCount,
    fields.productPrice,
  ]);
}

export interface WayForPayCallbackFields {
  merchantAccount: string;
  orderReference: string;
  amount: number;
  currency: string;
  authCode: string;
  cardPan: string;
  transactionStatus: string;
  reasonCode: string | number;
}

export function signCallback(
  secret: string,
  fields: WayForPayCallbackFields,
): string {
  return wayforpaySignature(secret, [
    fields.merchantAccount,
    fields.orderReference,
    fields.amount,
    fields.currency,
    fields.authCode,
    fields.cardPan,
    fields.transactionStatus,
    fields.reasonCode,
  ]);
}

export function signAcknowledgement(
  secret: string,
  orderReference: string,
  status: string,
  time: number,
): string {
  return wayforpaySignature(secret, [orderReference, status, time]);
}
