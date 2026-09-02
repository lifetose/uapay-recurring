import { describe, expect, it } from "vitest";

import {
  last4Of,
  numeric,
  redactTokens,
  text,
  toMajorUnits,
  toMinorUnits,
} from "./payload.js";

describe("text", () => {
  it("reads strings, numbers and booleans, and falls back otherwise", () => {
    expect(text("a")).toBe("a");
    expect(text(1)).toBe("1");
    expect(text(true)).toBe("true");
    expect(text(null, "none")).toBe("none");
    expect(text(undefined)).toBe("");
  });
});

describe("numeric", () => {
  it("reads numbers and numeric strings", () => {
    expect(numeric(4.99)).toBe(4.99);
    expect(numeric("4.99")).toBe(4.99);
  });

  it("falls back on anything that is not a finite number", () => {
    expect(numeric("abc", -1)).toBe(-1);
    expect(numeric(Number.NaN, -1)).toBe(-1);
    expect(numeric(Number.POSITIVE_INFINITY, -1)).toBe(-1);
    expect(numeric(null, -1)).toBe(-1);
  });
});

describe("amount conversion", () => {
  it("round-trips minor units without floating point drift", () => {
    for (const minor of [1, 99, 499, 4999, 123_456]) {
      expect(toMinorUnits(toMajorUnits(minor))).toBe(minor);
    }
  });

  it("renders minor units as two decimal places", () => {
    expect(toMajorUnits(499)).toBe(4.99);
    expect(toMajorUnits(500)).toBe(5);
  });
});

describe("last4Of", () => {
  it("reads the last four digits through a mask", () => {
    expect(last4Of("44**********4242")).toBe("4242");
    expect(last4Of("414963*36")).toBe("6336");
  });

  it("has no answer when there are not four digits", () => {
    expect(last4Of("**")).toBeUndefined();
  });
});

describe("redactTokens", () => {
  it("removes every token field, however deep", () => {
    expect(
      redactTokens({
        recToken: "a",
        nested: { card_token: "b", list: [{ cardToken: "c" }] },
        amount: 499,
      }),
    ).toEqual({
      recToken: "[redacted]",
      nested: {
        card_token: "[redacted]",
        list: [{ cardToken: "[redacted]" }],
      },
      amount: 499,
    });
  });

  it("leaves a value alone when the key is not a token field", () => {
    expect(redactTokens({ orderReference: "token" })).toEqual({
      orderReference: "token",
    });
  });
});
