// main.ts — the entry's lifecycle with the trial env, and nothing else:
// build the forge, bind an ephemeral port, POST the port to
// $MAKEFUN_ENV_URL/register, then poll $MAKEFUN_ENV_URL/done until the env
// ends the trial, close the server and exit 0. All state lives in the
// Forge instance app.ts serves; all timestamps inside it come from the
// trial clock, so a replayed trial produces the same bytes.

import { createForgeServer } from './app.ts';
import { ForgeClock } from './clock.ts';
import { Forge } from './store.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_FIRST_MS = 200;
const RETRY_CAP_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff between env calls, capped. */
function backoff(attempt: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_FIRST_MS * 2 ** Math.min(attempt, 8));
}

/**
 * Tell the env which port we bound. 200 (or 409 — a first register already
 * won) ends the loop; 400/405 mean the request itself is wrong and are
 * fatal; anything else is retried, since the env may still be starting.
 */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register refused with HTTP ${response.status}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('register refused')) throw error;
    }
    await sleep(backoff(attempt));
  }
}

/** Poll /done until the env answers {"done": true}; never return earlier. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
        attempt = 0; // The env is answering; poll it at the base cadence.
      }
    } catch {
      // Not answering yet is not "done"; keep polling with backoff.
    }
    await sleep(backoff(attempt));
  }
}

async function run(): Promise<void> {
  const clock = new ForgeClock(process.env.MAKEFUN_TRIAL_NOW);
  const forge = new Forge(clock);
  const server = createForgeServer(forge, { token: TOKEN });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server did not bind a TCP port');
  process.stdout.write(`[forge] listening on port ${address.port}\n`);

  if (ENV_URL === '') {
    // No env to register with (a local run): serve until killed.
    process.stdout.write('[forge] MAKEFUN_ENV_URL unset; serving standalone\n');
    return new Promise<void>(() => {});
  }

  await register(address.port);
  process.stdout.write('[forge] registered; waiting for done\n');
  await waitForDone();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.stdout.write('[forge] done\n');
}

try {
  await run();
  process.exit(0);
} catch (error) {
  process.stderr.write(`[forge] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
