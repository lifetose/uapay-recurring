import crypto from "node:crypto";

import { toBuffer } from "./payload.js";
import type { WebhookHeaders } from "./types.js";

export const MONOBANK_SIGNATURE_HEADER = "x-sign";

export function decodeMonobankPublicKey(publicKey: string): string {
  const trimmed = publicKey.trim();

  if (trimmed.startsWith("-----BEGIN")) {
    return trimmed;
  }

  return Buffer.from(trimmed, "base64").toString("utf8");
}

export function readHeader(
  headers: WebhookHeaders | undefined,
  name: string,
): string | undefined {
  if (!headers) {
    return undefined;
  }

  const getter = (headers as { get?: unknown }).get;

  if (typeof getter === "function") {
    return (
      (getter as (key: string) => string | null).call(headers, name) ??
      undefined
    );
  }

  const bag = headers as Record<string, string | string[] | undefined>;
  const value = bag[name] ?? bag[name.toLowerCase()];

  if (Array.isArray(value)) {
    return value[0];
  }

  return typeof value === "string" ? value : undefined;
}

export function verifyMonobankSignature(
  publicKey: string,
  rawBody: Buffer | string,
  signature: string,
): boolean {
  if (!signature) {
    return false;
  }

  let signatureBuffer: Buffer;

  try {
    signatureBuffer = Buffer.from(signature, "base64");
  } catch {
    return false;
  }

  if (!signatureBuffer.length) {
    return false;
  }

  try {
    const verifier = crypto.createVerify("SHA256");

    verifier.update(toBuffer(rawBody));
    verifier.end();

    return verifier.verify(decodeMonobankPublicKey(publicKey), signatureBuffer);
  } catch {
    return false;
  }
}
