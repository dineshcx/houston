// Small helpers every command uses: running processes, user-facing errors, durations.

/** An error meant for the person running Houston: printed without a stack trace. */
export class HoustonError extends Error {}

export type Result = { ok: boolean; code: number; stdout: string; stderr: string };

/** Runs a command and returns its output. Never throws; check `ok`. */
export function sh(cmd: string[], opts: { cwd?: string; input?: string; env?: Record<string, string> } = {}): Result {
  const p = Bun.spawnSync(cmd, {
    cwd: opts.cwd,
    stdin: opts.input === undefined ? "ignore" : new TextEncoder().encode(opts.input),
    env: { ...process.env, ...opts.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { ok: p.exitCode === 0, code: p.exitCode ?? 1, stdout: p.stdout.toString().trim(), stderr: p.stderr.toString().trim() };
}

/** Runs a command and returns stdout, or throws a HoustonError with its stderr. */
export function must(cmd: string[], opts: Parameters<typeof sh>[1] = {}): string {
  const r = sh(cmd, opts);
  if (!r.ok) throw new HoustonError(`\`${cmd.slice(0, 3).join(" ")}\` failed: ${r.stderr || r.stdout || `exit ${r.code}`}`);
  return r.stdout;
}

/** "15m", "3h", "2d", "2w" → milliseconds. */
export function parseDuration(text: string): number {
  const m = /^(\d+)\s*(m|h|d|w)$/.exec(String(text).trim());
  if (!m) throw new HoustonError(`"${text}" is not a duration. Use a number and a unit: 15m, 3h, 2d or 2w.`);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2] as "m" | "h" | "d" | "w"];
  return Number(m[1]) * unit;
}

/** Collapses whitespace and cuts text to `n` characters. */
export function clip(text: unknown, n: number): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n - 1) + "…";
}

export const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
