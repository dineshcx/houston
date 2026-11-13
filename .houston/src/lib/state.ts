// A person's run state on this machine: .houston-local/state.json (gitignored), and the run lock.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { paths } from "./paths";

/** "ok", or why a source failed. A failed source shows on the page as incomplete, never as a quiet day. */
export type SourceHealth = Record<string, string>;

export type State = {
  /** End of the window of the last published run; the next run collects from here. */
  last_publish?: string;
  last_run?: { at: string; outcome: "drafted" | "quiet" | "published" | "waiting" | "failed"; note?: string; sources?: SourceHealth };
  draft?: {
    created: string;
    window_start: string;
    window_end: string;
    /** When the draft publishes on its own (rules.publish_runs = review_until_deadline). */
    deadline?: string;
    held?: boolean;
    /** The person changed the draft (with `houston draft add` or by editing the file); no run replaces it. */
    edited?: boolean;
    /** Hash of draft.md as Houston last wrote it; a different hash means the person edited the file. */
    agent_hash: string;
    sources: SourceHealth;
    /** The inbox lines this draft was made from; publishing removes exactly these. */
    inbox: { file: string; lines: string[] }[];
    /** Issues already commented on by an earlier, interrupted publish, so a retry doesn't comment twice. */
    commented?: string[];
  };
  /** Hash of .houston/ (and the team's run skill) the person last approved; a changed core won't run unattended. */
  trusted_core?: string;
  /** The Houston repo's commit when the person last trusted the core, to show what changed since. */
  trusted_commit?: string;
};

export function readState(): State {
  return existsSync(paths.state) ? JSON.parse(readFileSync(paths.state, "utf8")) : {};
}

export function writeState(state: State) {
  mkdirSync(dirname(paths.state), { recursive: true });
  writeFileSync(paths.state, JSON.stringify(state, null, 2) + "\n");
}

export function updateState(change: (s: State) => void): State {
  const s = readState();
  change(s);
  writeState(s);
  return s;
}

export const hash = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 16);

/** Where a run's evidence starts: the end of the last published window, else 24 hours ago. */
export function windowStart(state: State, now: Date): Date {
  return state.last_publish ? new Date(state.last_publish) : new Date(now.getTime() - 86_400_000);
}

const LOCK = join(paths.localDir, "run.lock");

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** No run takes this long (the agent is stopped after 10 minutes), so an older lock is left over. */
const LOCK_STALE_MS = 30 * 60_000;

/**
 * Takes the one-run-at-a-time lock (a file holding our pid). Returns the release function, or
 * undefined when another live process holds it. A lock whose process died, or that is older than
 * any run (after a crash the pid may now belong to something else), is taken over.
 */
export function tryLock(): (() => void) | undefined {
  mkdirSync(paths.localDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(LOCK, String(process.pid), { flag: "wx" });
      return () => rmSync(LOCK, { force: true });
    } catch {
      const pid = Number(existsSync(LOCK) ? readFileSync(LOCK, "utf8") : 0);
      const old = existsSync(LOCK) && Date.now() - statSync(LOCK).mtimeMs > LOCK_STALE_MS;
      // ponytail: two runs taking over the same stale lock at the same instant can both proceed; rare enough.
      if (pid && alive(pid) && !old) return undefined;
      rmSync(LOCK, { force: true });
    }
  }
  return undefined;
}
