// A person's run state on this machine: .houston-local/state.json (gitignored).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
    /** Hash of draft.md as the run's agent left it; a different hash means the person edited it. */
    agent_hash: string;
    sources: SourceHealth;
  };
  /** Hash of .houston/ the person last approved; a changed core won't run unattended. */
  trusted_core?: string;
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
