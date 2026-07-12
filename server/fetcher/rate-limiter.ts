import { setTimeout as delay } from "node:timers/promises";

const MIN_INTERVAL_MS = 5_000;
const MAX_JITTER_MS = 3_000;

interface DomainState {
  tail: Promise<void>;
  lastStartedAt: number;
}

export class DomainRateLimiter {
  private readonly states = new Map<string, DomainState>();

  async run<T>(domain: string, work: () => Promise<T>): Promise<T> {
    const state = this.states.get(domain) ?? { tail: Promise.resolve(), lastStartedAt: 0 };
    this.states.set(domain, state);

    const result = state.tail.catch(() => undefined).then(async () => {
      const jitter = Math.floor(Math.random() * (MAX_JITTER_MS + 1));
      const wait = state.lastStartedAt + MIN_INTERVAL_MS + jitter - Date.now();
      if (wait > 0) await delay(wait);
      state.lastStartedAt = Date.now();
      return work();
    });
    state.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export const domainRateLimiter = new DomainRateLimiter();
