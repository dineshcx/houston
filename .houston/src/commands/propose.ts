// houston propose: opens one intake pull request in the Houston repo holding a meeting's notes and its
// proposed issue changes. It brings the repo up to date first, so the notes are written on top of
// teammates' latest page, then commits in a temporary worktree from the default branch, so the
// person's branch and other work are never touched. Only the files the PR carries are reset here.
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Command } from "../command";
import { loadTeam } from "../lib/config";
import { github } from "../lib/github";
import { paths } from "../lib/paths";
import { parseProposal, renderPrBody, setTopKey, slugify } from "../lib/proposals";
import { defaultBranch, git, hasRemote, houstonRepo, mustGit, pull, withWorktree } from "../lib/repo";
import { HoustonError, UsageError } from "../lib/util";

const today = () => new Date().toLocaleDateString("sv"); // YYYY-MM-DD in the person's timezone

/** A date-slug name not used by any proposal or intake branch yet. */
function uniqueName(base: string): string {
  const taken = (n: string) =>
    existsSync(join(paths.proposals, `${n}.yml`)) || existsSync(join(paths.proposals, "applied", `${n}.yml`)) || git(["ls-remote", "--exit-code", "--heads", "origin", `intake/${n}`]).ok;
  let name = base;
  for (let i = 2; taken(name); i++) name = `${base}-${i}`;
  return name;
}

/** Commits the files to a new branch made from origin's default branch, in a throwaway worktree, and pushes it. */
function pushBranch(branch: string, base: string, files: Record<string, string>, message: string) {
  mustGit(["fetch", "--quiet", "origin", base]);
  try {
    withWorktree(branch, `origin/${base}`, (dir) => {
      for (const [rel, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, rel)), { recursive: true });
        writeFileSync(join(dir, rel), text);
      }
      mustGit(["add", "--", ...Object.keys(files)], dir);
      mustGit(["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", message], dir);
      mustGit(["push", "--quiet", "origin", branch], dir);
    });
  } finally {
    git(["branch", "-D", branch]); // the branch lives on GitHub now; no need to keep it here
  }
}

/** A file in the repo that differs from the last commit (or isn't committed at all). */
const changed = (rel: string) => existsSync(join(paths.root, rel)) && (!git(["ls-files", "--error-unmatch", "--", rel]).ok || !git(["diff", "--quiet", "HEAD", "--", rel]).ok);

export default {
  summary: "Open an intake pull request: a meeting's notes plus its proposed issue changes",
  usage: `
houston propose --title "<title>" --notes <path in repo> --proposal <file> [--dry-run]

  --title     What the meeting or thread was, like "Daily sync 13 Nov"
  --notes     The notes file, as a path inside the Houston repo (written by you or the intake skill)
  --proposal  The proposal YAML (changes and skipped items) to open for review
  --dry-run   Print the pull request and its files without writing anything

Pulls the Houston repo first. The notes (and the project's ideas.md, if it has new lines) go into the
pull request; here they go back to how they are in the repo until it's merged.`,
  run(args) {
    const { values } = parseArgs({
      args,
      options: { title: { type: "string" }, notes: { type: "string" }, proposal: { type: "string" }, "dry-run": { type: "boolean" } },
      strict: true,
      allowPositionals: true,
    });
    const missing = (["title", "notes", "proposal"] as const).filter((k) => !values[k]).map((k) => `--${k}`);
    if (missing.length) throw new UsageError(`propose needs ${missing.join(", ")}.`);
    const dry = Boolean(values["dry-run"]);
    const team = loadTeam();

    const notes = relative(paths.root, resolve(paths.root, values.notes!));
    if (notes.startsWith("..") || isAbsolute(notes)) throw new UsageError(`--notes should be a path inside the Houston repo (${paths.root}); got ${values.notes}.`);
    if (!existsSync(join(paths.root, notes))) throw new HoustonError(`There are no notes at ${notes}. Write the meeting notes there first.`);
    if (!existsSync(values.proposal!)) throw new HoustonError(`There is no proposal file at ${values.proposal}.`);

    // Pull before reading the notes: a stale _page.md in the PR would overwrite what teammates added.
    if (!dry) {
      const pulled = pull();
      if (!pulled.ok) throw new HoustonError(`Nothing was proposed: ${pulled.note}`);
    }

    let text = readFileSync(values.proposal!, "utf8");
    // Each new key goes on top, so set them bottom-up to read title, owner, source.
    text = setTopKey(text, "source", notes);
    text = setTopKey(text, "owner", github().login());
    text = setTopKey(text, "title", values.title!);
    const remote = hasRemote();
    const name = remote ? uniqueName(`${today()}-${slugify(values.title!)}`) : `${today()}-${slugify(values.title!)}`;
    const file = `proposals/${name}.yml`;
    const proposal = parseProposal(text, team, values.proposal!);
    if (proposal.applied) throw new HoustonError(`${values.proposal} already has an applied: record. Start a new proposal without it.`);

    const n = proposal.changes.length;
    const title = `${values.title}: notes + ${n} issue change${n === 1 ? "" : "s"}`;
    const body = renderPrBody(proposal, file);
    const ideas = `projects/${proposal.project}/ideas.md`;
    const files: Record<string, string> = { [notes]: readFileSync(join(paths.root, notes), "utf8"), [file]: text };
    if (ideas !== notes && changed(ideas)) files[ideas] = readFileSync(join(paths.root, ideas), "utf8");

    if (dry) {
      console.log(`Would open a pull request on branch intake/${name}: "${title}"\n\n${body}\n`);
      for (const [rel, content] of Object.entries(files)) console.log(`----- ${rel} -----\n${content.trimEnd()}\n`);
      return;
    }
    if (!remote) throw new HoustonError("The Houston repo has no remote, so there's nowhere to open a pull request. Push it to GitHub first, then run this again.");
    const repo = houstonRepo();
    if (!repo) throw new HoustonError("The Houston repo's origin isn't on GitHub, so Houston can't open a pull request there.");

    const branch = `intake/${name}`;
    const base = defaultBranch();
    pushBranch(branch, base, files, `Intake: ${values.title}`);
    const url = github().createPullRequest(repo, { head: branch, base, title, body, labels: ["houston:intake"] });
    console.log(`Opened ${url}`);

    // The PR holds these files now. Left changed here, they would block the pull after it merges.
    for (const rel of Object.keys(files)) {
      if (!changed(rel)) continue;
      if (git(["ls-files", "--error-unmatch", "--", rel]).ok) mustGit(["checkout", "HEAD", "--", rel]);
      else unlinkSync(join(paths.root, rel));
      console.log(`Moved your changes to ${rel} into the pull request; they come back here when it's merged.`);
    }
  },
} satisfies Command;
