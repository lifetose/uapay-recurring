import crypto from "node:crypto";

export function liqpaySignature(privateKey: string, data: string): string {
  return crypto
    .createHash("sha1")
    .update(privateKey + data + privateKey, "utf8")
    .digest("base64");
}

export function encodeLiqPayData(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

export function decodeLiqPayData(data: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Buffer.from(data, "base64").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}
