import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  decodeMonobankPublicKey,
  readHeader,
  verifyMonobankSignature,
} from "./monobank-signature.js";

const keys = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });

const pem = keys.publicKey.export({ type: "spki", format: "pem" }) as string;

const base64 = Buffer.from(pem, "utf8").toString("base64");

const BODY = '{"invoiceId":"p2_abc","status":"success"}';

const signature = crypto
  .sign("SHA256", Buffer.from(BODY, "utf8"), keys.privateKey)
  .toString("base64");

describe("decodeMonobankPublicKey", () => {
  it("decodes the base64 wrapper monobank publishes", () => {
    expect(decodeMonobankPublicKey(base64)).toBe(pem);
  });

  it("passes an already decoded pem through", () => {
    expect(decodeMonobankPublicKey(pem)).toBe(pem.trim());
  });
});

describe("verifyMonobankSignature", () => {
  it("accepts a signature over the exact body", () => {
    expect(verifyMonobankSignature(base64, BODY, signature)).toBe(true);
  });

  it("accepts the body as a buffer", () => {
    expect(verifyMonobankSignature(base64, Buffer.from(BODY), signature)).toBe(
      true,
    );
  });

  it("rejects a body that changed by one character", () => {
    expect(verifyMonobankSignature(base64, `${BODY} `, signature)).toBe(false);
  });

  it("rejects an empty signature", () => {
    expect(verifyMonobankSignature(base64, BODY, "")).toBe(false);
  });

  it("rejects rather than throws on a malformed key", () => {
    expect(verifyMonobankSignature("not a key", BODY, signature)).toBe(false);
  });
});

describe("readHeader", () => {
  it("reads a plain node header bag, case insensitively", () => {
    expect(readHeader({ "x-sign": "abc" }, "x-sign")).toBe("abc");
  });

  it("takes the first value when node repeated the header", () => {
    expect(readHeader({ "x-sign": ["abc", "def"] }, "x-sign")).toBe("abc");
  });

  it("reads a fetch Headers object", () => {
    expect(readHeader(new Headers({ "X-Sign": "abc" }), "x-sign")).toBe("abc");
  });

  it("returns nothing when the header is absent", () => {
    expect(readHeader({}, "x-sign")).toBeUndefined();
    expect(readHeader(undefined, "x-sign")).toBeUndefined();
  });
});
