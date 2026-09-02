export const DEFAULT_DUNNING_DELAYS_MS = [
  24 * 60 * 60 * 1000,
  3 * 24 * 60 * 60 * 1000,
  3 * 24 * 60 * 60 * 1000,
];

export type DunningVerdict =
  | { action: "retry"; attempt: number; retryAt: Date }
  | { action: "give_up"; attempt: number };

export interface DunningOptions {
  delaysMs?: readonly number[];
  now?: Date;
}

export function nextDunningStep(
  failedCharges: number,
  options: DunningOptions = {},
): DunningVerdict {
  const delays = options.delaysMs ?? DEFAULT_DUNNING_DELAYS_MS;
  const now = options.now ?? new Date();
  const attempt = failedCharges + 1;
  const delay = delays[attempt - 1];

  if (delay === undefined) {
    return { action: "give_up", attempt };
  }

  return { action: "retry", attempt, retryAt: new Date(now.getTime() + delay) };
}
