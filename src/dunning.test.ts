import { describe, expect, it } from "vitest";

import { DEFAULT_DUNNING_DELAYS_MS, nextDunningStep } from "./dunning.js";

const NOW = new Date("2026-09-02T12:00:00.000Z");

describe("nextDunningStep", () => {
  it("retries a day after the first failure", () => {
    const verdict = nextDunningStep(0, { now: NOW });

    expect(verdict).toEqual({
      action: "retry",
      attempt: 1,
      retryAt: new Date("2026-09-03T12:00:00.000Z"),
    });
  });

  it("walks the whole ladder before giving up", () => {
    const attempts = DEFAULT_DUNNING_DELAYS_MS.map((_delay, index) =>
      nextDunningStep(index, { now: NOW }),
    );

    expect(attempts.every((step) => step.action === "retry")).toBe(true);
    expect(
      nextDunningStep(DEFAULT_DUNNING_DELAYS_MS.length, { now: NOW }),
    ).toEqual({
      action: "give_up",
      attempt: DEFAULT_DUNNING_DELAYS_MS.length + 1,
    });
  });

  it("honours a ladder of its own", () => {
    expect(nextDunningStep(0, { delaysMs: [1000], now: NOW })).toEqual({
      action: "retry",
      attempt: 1,
      retryAt: new Date("2026-09-02T12:00:01.000Z"),
    });

    expect(nextDunningStep(1, { delaysMs: [1000], now: NOW })).toEqual({
      action: "give_up",
      attempt: 2,
    });
  });

  it("gives up immediately when there is no ladder", () => {
    expect(nextDunningStep(0, { delaysMs: [], now: NOW }).action).toBe(
      "give_up",
    );
  });
});
