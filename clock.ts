// clock.ts — the forge's deterministic time source.
//
// Final trials are replayed and their exports must match byte for byte, so no
// wall clock and no randomness may ever reach stored state or an answer the
// suite compares. Every timestamp the forge hands out is derived from
// $MAKEFUN_TRIAL_NOW (an RFC 3339 UTC instant the harness fixes per trial)
// plus a logical counter that ticks once per handed-out timestamp, in request
// order. Two runs over the same request sequence therefore mint identical
// timestamps, identical ids, identical bytes.

/** Parse the trial's "now" into epoch seconds; 0 when unset or unparsable. */
function trialBaseSeconds(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 0;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && /^\d+$/.test(raw.trim())) {
    // A bare integer is epoch seconds (or milliseconds when implausibly large).
    return asNumber > 10_000_000_000 ? Math.floor(asNumber / 1000) : Math.floor(asNumber);
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

/** Format epoch seconds the way the REST surface spells timestamps. */
export function isoOf(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace('.000Z', 'Z');
}

/**
 * The forge clock: a base instant plus a tick counter. `tick()` is the only
 * way time moves, and it moves by exactly one second per call, so the order
 * objects were created in is recoverable from their timestamps alone.
 */
export class ForgeClock {
  private readonly base: number;
  private counter: number;

  constructor(nowRaw: string | undefined) {
    this.base = trialBaseSeconds(nowRaw);
    this.counter = 0;
  }

  /** The next timestamp, as epoch seconds. */
  tick(): number {
    const value = this.base + this.counter;
    this.counter += 1;
    return value;
  }

  /** The next timestamp, as an RFC 3339 UTC string. */
  tickIso(): string {
    return isoOf(this.tick());
  }

  /** The current counter position without consuming it (diagnostics only). */
  get ticks(): number {
    return this.counter;
  }
}

/**
 * A deterministic request-id source: monotonically numbered, hex-spelled.
 * The suite only requires the header to be present and non-empty, but a
 * counter keeps even the headers replay-stable.
 */
export class RequestIds {
  private counter: number;

  constructor() {
    this.counter = 0;
  }

  next(): string {
    this.counter += 1;
    return this.counter.toString(16).padStart(16, '0');
  }
}

/**
 * A small seeded PRNG (splitmix64 over the trial seed) for anything that
 * wants jitter-free variety. The forge's answers never depend on it today;
 * it exists so no future code reaches for Math.random by habit.
 */
export class SeededRandom {
  private state: bigint;

  constructor(seedRaw: string | undefined) {
    let seed = 0n;
    if (seedRaw !== undefined && /^\d+$/.test(seedRaw.trim())) {
      try {
        seed = BigInt(seedRaw.trim());
      } catch {
        seed = 0n;
      }
    }
    this.state = seed ^ 0x9e3779b97f4a7c15n;
  }

  /** Next unsigned 32-bit value. */
  nextU32(): number {
    this.state = (this.state + 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xffffffffffffffffn;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & 0xffffffffffffffffn;
    z = z ^ (z >> 31n);
    return Number(z & 0xffffffffn);
  }
}
