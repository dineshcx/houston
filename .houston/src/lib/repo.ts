// Committing to the Houston repo. Houston never commits to a code repo; this only ever runs in ROOT.
import { relative } from "node:path";
import { paths } from "./paths";
import { HoustonError, sh } from "./util";

export function git(args: string[]) {
  return sh(["git", "-C", paths.root, ...args]);
}

/** Brings in teammates' changes. Safe to call often: each writer owns its own files, so it never conflicts. */
export function pull(): { ok: boolean; note?: string } {
  if (!hasRemote()) return { ok: true, note: "no remote" };
  const r = git(["pull", "--rebase", "--autostash", "--quiet"]);
  return r.ok ? { ok: true } : { ok: false, note: r.stderr };
}

export function hasRemote() {
  return git(["remote"]).stdout.length > 0;
}

/**
 * Commits exactly these files (and nothing else the person has staged), then pushes.
 * Returns pushed=false with a note when there is no remote; throws if the push is refused twice.
 */
export function commitAndPush(files: string[], message: string): { committed: boolean; pushed: boolean; note?: string } {
  const rel = files.map((f) => relative(paths.root, f) || ".");
  const add = git(["add", "--", ...rel]);
  if (!add.ok) throw new HoustonError(`git add failed: ${add.stderr}`);
  if (git(["diff", "--cached", "--quiet", "--", ...rel]).ok) return { committed: false, pushed: false, note: "nothing changed" };
  const commit = git(["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", message, "--", ...rel]);
  if (!commit.ok) throw new HoustonError(`git commit failed: ${commit.stderr}`);
  if (!hasRemote()) return { committed: true, pushed: false, note: "no remote to push to" };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (git(["push", "--quiet"]).ok) return { committed: true, pushed: true };
    const p = pull();
    if (!p.ok) break;
  }
  throw new HoustonError("Committed, but couldn't push to the Houston repo. Run `git -C " + paths.root + " push` to see why.");
}

/** owner/name of the Houston repo on GitHub, from its origin remote. */
export function houstonRepo(): string | undefined {
  const url = git(["remote", "get-url", "origin"]).stdout;
  return /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url)?.[1];
}
