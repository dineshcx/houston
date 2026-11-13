// houston propose: opens one intake pull request in the Houston repo holding a meeting's notes and its
// proposed issue changes. It works in a temporary git worktree from the up-to-date default branch, so
// the person's own checkout (branch, staged and unstaged work) is never touched.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Command } from "../command";
import { loadTeam } from "../lib/config";
import { github } from "../lib/github";
import { paths } from "../lib/paths";
import { defaultBranch, parseProposal, renderPrBody, setTopKey, slugify } from "../lib/proposals";
import { git, hasRemote, houstonRepo } from "../lib/repo";
import { HoustonError, must } from "../lib/util";

const usage = `
houston propose --title "<title>" --notes <path in repo> --proposal <file> [--dry-run]

  --title     What the meeting or thread was, like "Daily sync 13 Nov"
  --notes     The notes file, as a path inside the Houston repo (written by you or the intake skill)
  --proposal  The proposal YAML (changes and skipped items) to open for review
  --dry-run   Print the pull request and its files without writing anything
`;

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
  must(["git", "-C", paths.root, "fetch", "--quiet", "origin", base]);
  const dir = mkdtempSync(join(tmpdir(), "houston-intake-"));
  must(["git", "-C", paths.root, "worktree", "add", "--quiet", "-b", branch, dir, `origin/${base}`]);
  try {
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
    must(["git", "-C", dir, "add", "--", ...Object.keys(files)]);
    must(["git", "-C", dir, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", message]);
    must(["git", "-C", dir, "push", "--quiet", "origin", branch]);
  } finally {
    git(["worktree", "remove", "--force", dir]);
    git(["branch", "-D", branch]);
    rmSync(dir, { recursive: true, force: true });
  }
}

export default {
  summary: "Open an intake pull request: a meeting's notes plus its proposed issue changes",
  usage,
  run(args) {
    const { values } = parseArgs({
      args,
      options: { title: { type: "string" }, notes: { type: "string" }, proposal: { type: "string" }, "dry-run": { type: "boolean" } },
      strict: true,
      allowPositionals: true,
    });
    if (!values.title || !values.notes || !values.proposal) throw new HoustonError(`propose needs --title, --notes and --proposal.\n${usage}`);
    const team = loadTeam();

    const notes = relative(paths.root, resolve(paths.root, values.notes));
    if (notes.startsWith("..") || isAbsolute(notes)) throw new HoustonError(`--notes should be a path inside the Houston repo (${paths.root}); got ${values.notes}.`);
    if (!existsSync(join(paths.root, notes))) throw new HoustonError(`There are no notes at ${notes}. Write the meeting notes there first.`);
    if (!existsSync(values.proposal)) throw new HoustonError(`There is no proposal file at ${values.proposal}.`);

    let text = readFileSync(values.proposal, "utf8");
    // Each new key goes on top, so set them bottom-up to read title, owner, source.
    text = setTopKey(text, "source", notes);
    text = setTopKey(text, "owner", github().login());
    text = setTopKey(text, "title", values.title);
    const remote = hasRemote();
    const name = remote ? uniqueName(`${today()}-${slugify(values.title)}`) : `${today()}-${slugify(values.title)}`;
    const file = `proposals/${name}.yml`;
    const proposal = parseProposal(text, team, values.proposal);
    if (proposal.applied) throw new HoustonError(`${values.proposal} already has an applied: record. Start a new proposal without it.`);

    const n = proposal.changes.length;
    const title = `${values.title}: notes + ${n} issue change${n === 1 ? "" : "s"}`;
    const body = renderPrBody(proposal, file);
    const files = { [notes]: readFileSync(join(paths.root, notes), "utf8"), [file]: text };

    if (values["dry-run"]) {
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

    // A file left untracked here would block the next `git pull` once the PR merges, so the PR now holds it.
    for (const rel of Object.keys(files)) {
      if (existsSync(join(paths.root, rel)) && !git(["ls-files", "--error-unmatch", "--", rel]).ok) {
        unlinkSync(join(paths.root, rel));
        console.log(`Moved ${rel} into the pull request; it comes back here when the PR is merged.`);
      }
    }
    console.log(url);
  },
} satisfies Command;
