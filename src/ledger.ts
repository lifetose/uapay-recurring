import { ProviderName } from "./types.js";

export interface EventLedger {
  claim(provider: ProviderName, eventId: string): Promise<boolean>;
}

export interface MemoryEventLedgerOptions {
  limit?: number;
}

const DEFAULT_LIMIT = 1000;

export class MemoryEventLedger implements EventLedger {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];
  private readonly limit: number;

  constructor(options: MemoryEventLedgerOptions = {}) {
    this.limit = options.limit ?? DEFAULT_LIMIT;
  }

  public claim(provider: ProviderName, eventId: string): Promise<boolean> {
    const key = `${provider}:${eventId}`;

    if (this.seen.has(key)) {
      return Promise.resolve(false);
    }

    this.seen.add(key);
    this.order.push(key);

    while (this.order.length > this.limit) {
      const dropped = this.order.shift();

      if (dropped !== undefined) {
        this.seen.delete(dropped);
      }
    }

    return Promise.resolve(true);
  }
}
