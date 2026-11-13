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
import { coreVersion } from "../lib/paths";
import { defaultBranch, git, hasRemote, houstonRepo, mustGit, withWorktree } from "../lib/repo";
import { HoustonError, sh } from "../lib/util";

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
The pull request goes against the default branch. Your config, notes and own skills are never
touched, and your checkout isn't switched.`,
  async run(args) {
    const { values } = parseArgs({ args, strict: true, allowPositionals: true, options: { from: { type: "string" }, ref: { type: "string" } } });
    const team = loadTeam();
    const from = values.from ?? team.template;
    if (!from) throw new HoustonError("Where should the new core come from? Add `template: owner/name` to houston.yml, or run `houston update --from owner/name`.");
    const url = process.env.HOUSTON_TEMPLATE_URL ?? `https://github.com/${from}.git`;
    const at = values.ref ? ` at ${values.ref}` : "";
    const installed = await coreVersion();

    const tmp = mkdtempSync(join(tmpdir(), "houston-update-"));
    try {
      const src = join(tmp, "template");
      const clone = sh(["git", "clone", "--quiet", "--depth", "1", ...(values.ref ? ["--branch", values.ref] : []), url, src]);
      if (!clone.ok) throw new HoustonError(`Couldn't fetch ${from}${at}: ${clone.stderr}`);
      const versionFile = join(src, ".houston", "VERSION");
      if (!existsSync(versionFile)) throw new HoustonError(`${from} has no .houston/VERSION, so it isn't a Houston template.`);
      const incoming = readFileSync(versionFile, "utf8").trim();
      if (!isNewer(incoming, installed)) throw new HoustonError(`${from}${at} has core ${incoming}; you already have ${installed}. Nothing to update.`);

      const branch = `houston-update-${incoming}`;
      if (git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok)
        throw new HoustonError(`Branch ${branch} already exists, from an earlier update. Open a pull request from it, or delete it with \`git branch -D ${branch}\` and run this again.`);
      // The PR goes against the branch everyone merges into, whatever this checkout is on.
      const base = defaultBranch();
      const remote = hasRemote();
      if (remote) mustGit(["fetch", "--quiet", "origin", base]);
      const message = `Update Houston core ${installed} → ${incoming}`;

      withWorktree(branch, remote ? `origin/${base}` : base, (work) => {
        rmSync(join(work, ".houston"), { recursive: true, force: true });
        cpSync(join(src, ".houston"), join(work, ".houston"), { recursive: true, filter: (p) => !p.split("/").includes("node_modules") });
        const yml = join(work, "houston.yml");
        if (existsSync(yml)) writeFileSync(yml, readFileSync(yml, "utf8").replace(/^(core:\s*)[^\s#]+/m, `$1${incoming}`));
        mustGit(["add", "-A", "--", ".houston", "houston.yml"], work);
        mustGit(["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", message], work);
        if (remote && houstonRepo()) mustGit(["push", "--quiet", "-u", "origin", branch], work);
      });

      const repo = houstonRepo();
      if (!remote || !repo) return console.log(`✓ Committed ${message} on branch ${branch}. There's no GitHub remote: push the branch and open a pull request against ${base} when you're ready.`);
      const body = [
        `Updates the Houston core in \`.houston/\` from **${installed}** to **${incoming}** (from \`${from}\`${values.ref ? ` at \`${values.ref}\`` : ""}), and bumps \`core:\` in houston.yml.`,
        "",
        "The core runs unattended on every teammate's laptop, so the CODEOWNERS for `.houston/` should review this change before merging.",
        "After it merges, each person reviews and runs `houston trust` once; until then their runs won't use the new core.",
      ].join("\n");
      const pr = github().createPullRequest(repo, { head: branch, base, title: message, body });
      console.log(`✓ Opened ${pr}\nAsk a CODEOWNER to review it.`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  },
} satisfies Command;
