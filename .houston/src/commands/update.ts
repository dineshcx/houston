// houston update: brings a newer core into .houston/ as a pull request. The change is made in a
// temporary git worktree on its own branch, so the person's checkout (and their runs) never sit on
// an unreviewed core; CODEOWNERS review the PR, then everyone runs `houston trust` after pulling it.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Command } from "../command";
import { loadTeam } from "../lib/config";
import { github } from "../lib/github";
import { paths } from "../lib/paths";
import { git, hasRemote, houstonRepo } from "../lib/repo";
import { HoustonError, must, sh } from "../lib/util";

/** True when version a is newer than b ("0.10.0" > "0.9.1"). */
export function isNewer(a: string, b: string): boolean {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

export default {
  summary: "Bring a newer Houston core into .houston/ as a pull request",
  usage: `
houston update [--from owner/repo] [--ref <tag>]

Fetches the Houston template (default: template: in houston.yml) at a tag or its default branch,
and if its core is newer, opens a pull request replacing .houston/ and bumping core: in houston.yml.
Your config, notes and own skills are never touched. Your current branch isn't changed.`,
  run(args) {
    const { values } = parseArgs({ args, strict: true, allowPositionals: true, options: { from: { type: "string" }, ref: { type: "string" } } });
    const team = loadTeam();
    const from = values.from ?? team.template;
    if (!from) throw new HoustonError("Where should the new core come from? Add `template: owner/name` to houston.yml, or run `houston update --from owner/name`.");
    const url = process.env.HOUSTON_TEMPLATE_URL ?? `https://github.com/${from}.git`;
    const installedFile = join(paths.root, ".houston", "VERSION");
    const installed = existsSync(installedFile) ? readFileSync(installedFile, "utf8").trim() : team.core;

    const tmp = mkdtempSync(join(tmpdir(), "houston-update-"));
    const src = join(tmp, "template");
    const work = join(tmp, "work");
    let worktree = false;
    try {
      const clone = sh(["git", "clone", "--quiet", "--depth", "1", ...(values.ref ? ["--branch", values.ref] : []), url, src]);
      if (!clone.ok) throw new HoustonError(`Couldn't fetch ${from}${values.ref ? ` at ${values.ref}` : ""}: ${clone.stderr}`);
      const versionFile = join(src, ".houston", "VERSION");
      if (!existsSync(versionFile)) throw new HoustonError(`${from} has no .houston/VERSION, so it isn't a Houston template.`);
      const incoming = readFileSync(versionFile, "utf8").trim();
      if (!isNewer(incoming, installed)) throw new HoustonError(`${from}${values.ref ? ` at ${values.ref}` : ""} has core ${incoming}; you already have ${installed}. Nothing to update.`);

      const branch = `houston-update-${incoming}`;
      const base = git(["branch", "--show-current"]).stdout;
      const add = git(["worktree", "add", "--quiet", "-b", branch, work, "HEAD"]);
      if (!add.ok) throw new HoustonError(`Couldn't start branch ${branch}: ${add.stderr}. If an earlier update left it behind, delete it with \`git branch -D ${branch}\`.`);
      worktree = true;

      rmSync(join(work, ".houston"), { recursive: true, force: true });
      cpSync(join(src, ".houston"), join(work, ".houston"), { recursive: true, filter: (p) => !p.split("/").includes("node_modules") });
      const yml = join(work, "houston.yml");
      if (existsSync(yml)) writeFileSync(yml, readFileSync(yml, "utf8").replace(/^(core:\s*)[^\s#]+/m, `$1${incoming}`));

      const message = `Update Houston core ${installed} → ${incoming}`;
      must(["git", "-C", work, "add", "-A", "--", ".houston", "houston.yml"]);
      must(["git", "-C", work, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", message]);

      const repo = houstonRepo();
      if (!hasRemote() || !repo) {
        console.log(`✓ Committed ${message} on branch ${branch}. There's no GitHub remote: push the branch and open a pull request when you're ready.`);
        return;
      }
      must(["git", "-C", work, "push", "--quiet", "-u", "origin", branch]);
      const body = [
        `Updates the Houston core in \`.houston/\` from **${installed}** to **${incoming}** (from \`${from}\`${values.ref ? ` at \`${values.ref}\`` : ""}), and bumps \`core:\` in houston.yml.`,
        "",
        "The core runs unattended on every teammate's laptop, so the CODEOWNERS for `.houston/` should review this change before merging.",
        "After it merges, each person reviews and runs `houston trust` once; until then their runs won't use the new core.",
      ].join("\n");
      const pr = github().createPullRequest(repo, { head: branch, base: base || "main", title: message, body });
      console.log(`✓ Opened ${pr}\nAsk a CODEOWNER to review it.`);
    } finally {
      if (worktree) git(["worktree", "remove", "--force", work]);
      rmSync(tmp, { recursive: true, force: true });
    }
  },
} satisfies Command;
