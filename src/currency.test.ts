import { describe, expect, it } from "vitest";

import { currencyAlpha, currencyNumber } from "./currency.js";

describe("currencyNumber", () => {
  it("maps the codes a Ukrainian merchant actually bills in", () => {
    expect(currencyNumber("UAH")).toBe(980);
    expect(currencyNumber("USD")).toBe(840);
    expect(currencyNumber("EUR")).toBe(978);
  });

  it("ignores case and padding", () => {
    expect(currencyNumber(" uah ")).toBe(980);
  });

  it("passes a number straight through", () => {
    expect(currencyNumber("980")).toBe(980);
  });

  it("refuses a code it does not know rather than guessing", () => {
    expect(() => currencyNumber("XYZ")).toThrow(/ISO 4217/);
  });
});

describe("currencyAlpha", () => {
  it("reads a number back", () => {
    expect(currencyAlpha(980)).toBe("UAH");
  });

  it("returns the number when it knows no name for it", () => {
    expect(currencyAlpha(999)).toBe("999");
  });
});
