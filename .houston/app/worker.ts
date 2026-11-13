// The app's slow work, run on a worker thread (one per request, see inWorker in api/common.ts):
// GitHub reads through the core's `gh` wrapper, intake branches fetched with git, and committing and
// pushing the Notes. The core's helpers are synchronous; here they only block this thread.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { teamRepos, type Team } from "../src/lib/config";
import { github, type Issue, type IssueRef } from "../src/lib/github";
import { paths } from "../src/lib/paths";
import { describeChange, parseProposal, type Change } from "../src/lib/proposals";
import { commitAndPush, defaultBranch, git, hasRemote, houstonRepo, pull } from "../src/lib/repo";
import { hash } from "../src/lib/state";
import { HoustonError, sh } from "../src/lib/util";

declare const self: Worker;

/** Every open issue in the team's repos. A repo that fails is reported, not fatal. */
function board(team: Team) {
  const issues: { issue: Issue; project: string }[] = [];
  const errors: string[] = [];
  for (const r of teamRepos(team)) {
    try {
      issues.push(...github().issues(r.repo).map((issue) => ({ issue, project: r.project })));
    } catch (e) {
      errors.push(`${r.repo}: ${(e as Error).message}`);
    }
  }
  return { issues, errors };
}

/** An issue's comments, oldest first: one `gh` call (the fake keeps them as plain strings). */
function comments(ref: IssueRef): { author: string; body: string; createdAt: string | null }[] {
  if (process.env.HOUSTON_FAKE_GITHUB) return ((github().issue(ref) as Issue & { comments?: string[] }).comments ?? []).map((body) => ({ author: "", body, createdAt: null }));
  const r = sh(["gh", "issue", "view", String(ref.number), "-R", ref.repo, "--json", "comments"]);
  if (!r.ok) throw new HoustonError(`Couldn't read the comments: ${r.stderr}`);
  return (JSON.parse(r.stdout).comments ?? []).map((c: any) => ({ author: c.author?.login ?? "", body: c.body ?? "", createdAt: c.createdAt ?? null }));
}

/** A proposed change as data for the review screen, next to the sentence the PR body uses. */
function structured(change: Change) {
  if ("create" in change) return { kind: "create" as const, target: change.create.repo, text: describeChange(change), fields: change.create };
  if ("update" in change) return { kind: "update" as const, target: change.update.issue, text: describeChange(change), fields: change.update };
  return { kind: "comment" as const, target: change.comment.issue, text: describeChange(change), fields: change.comment };
}

/** An intake PR's notes and proposal, read from its branch without checking it out, and checked like `houston apply` would. */
function intake(team: Team, base: string, branch: string) {
  if (!/^[\w][\w./-]*$/.test(branch) || branch.includes("..")) return { error: `The branch name "${branch}" looks unusual, so Houston didn't fetch it.` };
  const fetched = git(["fetch", "--quiet", "origin", branch]);
  if (!fetched.ok) return { error: `Couldn't fetch ${branch}: ${fetched.stderr}` };
  const names = git(["diff", "--name-only", `origin/${base}...origin/${branch}`]).stdout.split("\n").filter(Boolean);
  const show = (path: string) => git(["show", `origin/${branch}:${path}`]).stdout;
  const notes = names.filter((n) => n.endsWith(".md")).map((path) => ({ path, text: show(path) }));
  const proposalPath = names.find((n) => /^proposals\/.+\.ya?ml$/.test(n));
  if (!proposalPath) return { notes, proposalPath: null };
  try {
    const p = parseProposal(show(proposalPath), team, proposalPath);
    return { notes, proposalPath, proposalTitle: p.title, project: p.project, source: p.source, owner: p.owner ?? null, changes: p.changes.map(describeChange), proposed: p.changes.map(structured), skipped: p.skipped };
  } catch (e) {
    if (!(e instanceof HoustonError)) throw e;
    return { notes, proposalPath, refused: e.message };
  }
}

function review(team: Team) {
  const repo = houstonRepo();
  if (!repo) return { repo: null, prs: [] };
  const base = defaultBranch();
  const prs = github()
    .pullRequests(repo, { label: "houston:intake" })
    .map((p) => ({ number: p.number, title: p.title, author: p.author, url: p.url, branch: p.branch, updatedAt: p.updatedAt, ...intake(team, base, p.branch) }));
  return { repo, prs };
}

/**
 * Commits and pushes one Notes file. Checks first whether a teammate pushed a change to the same
 * file: then nothing is committed, the file goes back to theirs and both texts come back (409), so
 * a rebase never has to merge two edits of the Notes. The person's text is also kept in
 * .houston-local/conflicts/ so nothing typed is ever lost.
 */
function syncNotes(file: string, message: string) {
  const rel = relative(paths.root, file);
  if (hasRemote()) {
    const branch = defaultBranch();
    if (!git(["fetch", "--quiet", "origin", branch]).ok) throw Object.assign(new HoustonError("Couldn't reach the Houston repo's remote, so the notes are saved on this laptop but not pushed yet. Try again when you're online."), { status: 503 });
    const blob = (rev: string) => git(["rev-parse", "--verify", "--quiet", `${rev}:${rel}`]).stdout;
    const base = git(["merge-base", "HEAD", `origin/${branch}`]).stdout;
    if (base && blob(`origin/${branch}`) !== blob(base)) {
      const mine = readFileSync(file, "utf8");
      mkdirSync(join(paths.localDir, "conflicts"), { recursive: true });
      const backup = join(paths.localDir, "conflicts", `${rel.replace(/[/\\]/g, "_")}-${Date.now()}.md`);
      writeFileSync(backup, mine);
      git(["checkout", "--", rel]);
      const pulled = pull();
      const theirs = readFileSync(file, "utf8");
      return { conflict: true, mine, theirs, hash: hash(theirs), backup, note: pulled.ok ? undefined : pulled.note };
    }
  }
  return { conflict: false, ...commitAndPush([file], message), hash: hash(readFileSync(file, "utf8")) };
}

const OPS: Record<string, (...args: any[]) => unknown> = {
  board,
  issue: (ref: IssueRef) => github().issue(ref),
  comments,
  review,
  merge: (repo: string, n: number) => github().mergePullRequest(repo, n),
  syncNotes,
};

self.onmessage = (e: MessageEvent) => {
  const { op, args } = e.data as { op: string; args: unknown[] };
  try {
    postMessage({ ok: true, data: OPS[op](...args) });
  } catch (err) {
    postMessage({ ok: false, error: (err as Error).message, houston: err instanceof HoustonError, status: (err as { status?: number }).status });
  }
};
