// Git in the Houston repo. Houston never commits to a code repo. Commits to the person's checkout go
// through commitAndPush, which refuses a repo in the middle of something (see notReady); commits for
// pull requests go through withWorktree, which never touches the checkout at all.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { paths } from "./paths";
import { HoustonError, sh, type Result } from "./util";

/** Runs git in the Houston repo (or `cwd`). Never throws; check `ok`. */
export function git(args: string[], cwd = paths.root): Result {
  return sh(["git", "-C", cwd, ...args]);
}

/** Runs git and returns stdout, or throws a HoustonError with git's own message. */
export function mustGit(args: string[], cwd = paths.root): string {
  const r = git(args, cwd);
  if (!r.ok) throw new HoustonError(`git ${args[0]} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

/** owner/name from a GitHub remote URL (https or ssh), or undefined. */
export function repoFromUrl(url: string): string | undefined {
  return /github\.com[:/]+([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1];
}

/** owner/name of a checkout's origin on GitHub. */
export function originOf(dir: string): string | undefined {
  const r = git(["remote", "get-url", "origin"], dir);
  return r.ok ? repoFromUrl(r.stdout) : undefined;
}

/** owner/name of the Houston repo on GitHub. */
export const houstonRepo = () => originOf(paths.root);

export function hasRemote() {
  return git(["remote"]).stdout.length > 0;
}

/** The branch everyone merges into: origin's HEAD, or the current branch when there is no remote. */
export function defaultBranch(): string {
  const head = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head.ok) return head.stdout.replace(/^origin\//, "");
  const m = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(git(["ls-remote", "--symref", "origin", "HEAD"]).stdout);
  return m?.[1] ?? git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout;
}

/**
 * Why the Houston repo isn't safe to commit to right now, or undefined if it is. Runs commit to the
 * default branch only; a person halfway through a rebase or on another branch has to finish first.
 */
export function notReady(): string | undefined {
  const gitDir = mustGit(["rev-parse", "--absolute-git-dir"]);
  if (["rebase-merge", "rebase-apply", "MERGE_HEAD"].some((f) => existsSync(join(gitDir, f))))
    return `the Houston repo (${paths.root}) is in the middle of a rebase or merge. Finish it (or \`git rebase --abort\`) and try again.`;
  const branch = git(["symbolic-ref", "--short", "HEAD"]);
  if (!branch.ok) return `the Houston repo (${paths.root}) isn't on a branch. Run \`git -C ${paths.root} switch ${defaultBranch()}\`.`;
  const main = hasRemote() ? defaultBranch() : branch.stdout;
  if (branch.stdout !== main) return `the Houston repo (${paths.root}) is on branch ${branch.stdout}. Houston writes to ${main}; switch back with \`git -C ${paths.root} switch ${main}\`.`;
}

/**
 * Brings in teammates' changes. Each writer owns its own files, so this normally never conflicts;
 * if it does, the rebase is aborted so the repo is left exactly as it was.
 */
export function pull(): { ok: boolean; note?: string } {
  if (!hasRemote()) return { ok: true, note: "no remote" };
  const problem = notReady();
  if (problem) return { ok: false, note: problem };
  const r = git(["pull", "--rebase", "--autostash", "--quiet"]);
  if (r.ok) return { ok: true };
  git(["rebase", "--abort"]);
  return { ok: false, note: `couldn't bring in teammates' changes, so nothing was changed: ${r.stderr}` };
}

/** True when the current branch has commits its upstream doesn't. */
function ahead(): boolean {
  const r = git(["rev-list", "--count", "@{upstream}..HEAD"]);
  return r.ok && Number(r.stdout) > 0;
}

/**
 * Commits exactly these files (nothing else the person has staged) and pushes. Also pushes earlier
 * commits a failed push left behind. Throws if the repo isn't ready or the push is refused twice.
 */
export function commitAndPush(files: string[], message: string): { committed: boolean; pushed: boolean; note?: string } {
  const problem = notReady();
  if (problem) throw new HoustonError(problem);
  const rel = files.map((f) => relative(paths.root, f) || ".");
  mustGit(["add", "--", ...rel]);
  const changed = !git(["diff", "--cached", "--quiet", "--", ...rel]).ok;
  if (changed) mustGit(["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", message, "--", ...rel]);
  if (!hasRemote()) return { committed: changed, pushed: false, note: "no remote to push to" };
  if (!changed && !ahead() && git(["rev-parse", "--abbrev-ref", "@{upstream}"]).ok) return { committed: false, pushed: false, note: "nothing changed" };
  if (!git(["rev-parse", "--abbrev-ref", "@{upstream}"]).ok) {
    if (git(["push", "--quiet", "-u", "origin", "HEAD"]).ok) return { committed: changed, pushed: true };
    throw new HoustonError(`Committed, but couldn't push: the branch has no upstream and \`git push -u origin HEAD\` failed. Run it in ${paths.root} to see why.`);
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    if (git(["push", "--quiet"]).ok) return { committed: changed, pushed: true };
    if (!pull().ok) break;
  }
  throw new HoustonError(`Committed, but couldn't push to the Houston repo. Run \`git -C ${paths.root} push\` to see why; the next run tries again.`);
}

/**
 * Runs `fn` in a throwaway worktree on a new branch made from `base`, so the person's own checkout
 * is never switched or touched. The worktree is always removed afterwards.
 */
export function withWorktree<T>(branch: string, base: string, fn: (dir: string) => T): T {
  const parent = mkdtempSync(join(tmpdir(), "houston-"));
  const dir = join(parent, "work");
  mustGit(["worktree", "add", "--quiet", "-b", branch, dir, base]);
  try {
    return fn(dir);
  } finally {
    git(["worktree", "remove", "--force", dir]);
    rmSync(parent, { recursive: true, force: true });
  }
}
