import { describe, expect, it } from "vitest";

import { addMonths, nextPeriodStart, paymentReference } from "./period.js";

describe("addMonths", () => {
  it("moves forward a whole month", () => {
    expect(
      addMonths(new Date("2026-01-15T10:00:00.000Z"), 1).toISOString(),
    ).toBe("2026-02-15T10:00:00.000Z");
  });

  it("clamps a day the target month does not have", () => {
    expect(
      addMonths(new Date("2026-01-31T10:00:00.000Z"), 1).toISOString(),
    ).toBe("2026-02-28T10:00:00.000Z");
  });

  it("lands on the 29th in a leap year", () => {
    expect(
      addMonths(new Date("2028-01-31T10:00:00.000Z"), 1).toISOString(),
    ).toBe("2028-02-29T10:00:00.000Z");
  });

  it("crosses the year boundary", () => {
    expect(
      addMonths(new Date("2026-01-15T10:00:00.000Z"), 12).toISOString(),
    ).toBe("2027-01-15T10:00:00.000Z");
  });

  it("does not mutate the date it is given", () => {
    const from = new Date("2026-01-31T10:00:00.000Z");

    addMonths(from, 1);

    expect(from.toISOString()).toBe("2026-01-31T10:00:00.000Z");
  });
});

describe("nextPeriodStart", () => {
  const now = new Date("2026-09-02T12:00:00.000Z");

  it("starts the next period where the current one ends", () => {
    const end = new Date("2026-09-20T12:00:00.000Z");

    expect(nextPeriodStart(end, now)).toEqual(end);
  });

  it("starts now when the period already lapsed", () => {
    expect(nextPeriodStart(new Date("2026-08-01T12:00:00.000Z"), now)).toEqual(
      now,
    );
  });

  it("starts now when there is no period yet", () => {
    expect(nextPeriodStart(undefined, now)).toEqual(now);
  });
});

describe("paymentReference", () => {
  it("is unique across calls and carries the prefix", () => {
    const references = new Set(
      Array.from({ length: 200 }, () => paymentReference("shop")),
    );

    expect(references.size).toBe(200);
    expect([...references].every((ref) => ref.startsWith("shop-"))).toBe(true);
  });
});
