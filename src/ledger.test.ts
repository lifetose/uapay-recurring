import { describe, expect, it } from "vitest";

import { MemoryEventLedger } from "./ledger.js";

describe("MemoryEventLedger", () => {
  it("claims an event once", async () => {
    const ledger = new MemoryEventLedger();

    expect(await ledger.claim("wayforpay", "evt-1")).toBe(true);
    expect(await ledger.claim("wayforpay", "evt-1")).toBe(false);
  });

  it("keeps providers apart", async () => {
    const ledger = new MemoryEventLedger();

    expect(await ledger.claim("wayforpay", "evt-1")).toBe(true);
    expect(await ledger.claim("liqpay", "evt-1")).toBe(true);
  });

  it("forgets the oldest events past its limit", async () => {
    const ledger = new MemoryEventLedger({ limit: 2 });

    await ledger.claim("liqpay", "a");
    await ledger.claim("liqpay", "b");
    await ledger.claim("liqpay", "c");

    expect(await ledger.claim("liqpay", "a")).toBe(true);
    expect(await ledger.claim("liqpay", "c")).toBe(false);
  });
});
