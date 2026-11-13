// What every API handler shares: the per-request context, HTTP errors, the houston CLI (run
// asynchronously, so a publish doesn't freeze other requests), GitHub reads in a worker thread, a
// one-minute cache, and a queue so two git writes never run at once.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { formatAt, zoned } from "../../src/lib/cadence";
import { loadContext, type Context } from "../../src/lib/config";
import { paths } from "../../src/lib/paths";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    /** More fields for the error's JSON, like both texts of a conflict. */
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export type Ctx = Context & { today: string; now: Date };

/** Re-read on every request so edits to houston.yml or cadences/ show without a restart. */
export function context(): Ctx {
  const ctx = loadContext();
  const now = new Date();
  return { ...ctx, now, today: zoned(now, ctx.local.timezone).date };
}

export const at = (ctx: Ctx, t: string | Date) => formatAt(t, ctx.local.timezone);

/** "Fri 13 Nov", for labels. */
export function dayLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).replace(",", "");
}

// ---------- the houston CLI ----------

/**
 * Runs the houston CLI: the trusted copy when there is one, else this core, with the same guards
 * as the shim (no .env, Houston's own bunfig.toml) so files at the repo root can't run code.
 */
export async function houston(args: string[]): Promise<{ ok: boolean; output: string }> {
  const cli = existsSync(paths.bin) ? [paths.bin] : [process.execPath, "--no-env-file", `--config=${join(paths.core, "bunfig.toml")}`, join(paths.core, "src/cli.ts")];
  const p = Bun.spawn([...cli, ...args], { cwd: paths.root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { ok: code === 0, output: [stdout.trim(), stderr.trim()].filter(Boolean).join("\n") };
}

export async function mustHouston(args: string[]): Promise<string> {
  const r = await houston(args);
  if (!r.ok) throw new HttpError(422, r.output || `houston ${args[0]} failed.`);
  return r.output;
}

// ---------- slow work off the main thread ----------

/**
 * Runs one operation from worker.ts on its own thread. The core's GitHub and git helpers are
 * synchronous (spawnSync); on a worker they only block that worker, never the server.
 */
export function inWorker<T>(op: string, ...args: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("../worker.ts", import.meta.url).href);
    w.onmessage = (e: MessageEvent) => {
      w.terminate();
      if (e.data.ok) resolve(e.data.data);
      else reject(e.data.status ? new HttpError(e.data.status, e.data.error) : new HttpError(e.data.houston ? 400 : 502, e.data.error));
    };
    w.onerror = (e: ErrorEvent) => {
      w.terminate();
      reject(new Error(e.message));
    };
    w.postMessage({ op, args });
  });
}

let chain: Promise<unknown> = Promise.resolve();
/** Git writes (CLI writes, notes syncs) one at a time, in the order they were asked for. */
export function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

// ---------- the GitHub cache ----------

export const GITHUB_TTL_MS = 60_000;
type Entry<T> = { at: number; data: Promise<T>; done?: { value: T } };
const cache = new Map<string, Entry<unknown>>();

/**
 * GitHub reads are slow; screens share one copy for a minute unless the person asks to refresh.
 * Concurrent requests share one load. A failed load isn't kept.
 */
export async function cached<T>(key: string, refresh: boolean, load: () => Promise<T>): Promise<{ at: number; data: T }> {
  let hit = cache.get(key) as Entry<T> | undefined;
  if (refresh || !hit || Date.now() - hit.at >= GITHUB_TTL_MS) {
    const entry: Entry<T> = { at: Date.now(), data: load() };
    cache.set(key, entry);
    entry.data.then(
      (value) => (entry.done = { value }),
      () => cache.get(key) === entry && cache.delete(key),
    );
    hit = entry;
  }
  return { at: hit.at, data: await hit.data };
}

/** The cached value if there is a fresh, finished one; never loads. */
export function peek<T>(key: string): { at: number; data: T } | undefined {
  const hit = cache.get(key) as Entry<T> | undefined;
  return hit?.done && Date.now() - hit.at < GITHUB_TTL_MS ? { at: hit.at, data: hit.done.value } : undefined;
}

/** Changes a cached value in place (a status move), so the board doesn't refetch after it. */
export function patch<T>(key: string, change: (data: T) => void) {
  const hit = cache.get(key) as Entry<T> | undefined;
  if (hit?.done) change(hit.done.value);
}

/** Drops a cached key, or every key under a prefix ("issue" drops "issue:acme/web#1" and the rest). */
export function forget(key: string) {
  for (const k of [...cache.keys()]) if (k === key || k.startsWith(`${key}:`)) cache.delete(k);
}
export const iso = (ms: number) => new Date(ms).toISOString();
