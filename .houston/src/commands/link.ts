// houston link: one person's machine setup. Finds the team's repos, writes houston.local.yml, the
// `.houston` pointer and inbox in each repo (hidden through .git/info/exclude), AGENTS.local.md and
// the block in ~/.claude/CLAUDE.md. Every step is planned first and only written if it changes
// something, so running it again changes nothing and --dry-run shows exactly what would happen.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Command } from "../command";
import { loadTeam, projectOf, teamRepos, type Local } from "../lib/config";
import { isTrusted, trustCore } from "../lib/core";
import { github } from "../lib/github";
import { coreVersion, IN_CODE_REPO, paths } from "../lib/paths";
import { git } from "../lib/repo";
import { agentsLocalText, excludeFile, findRepos, globalBlock, globalFile, home, localText, originOf, pointerText, readLocalRaw, systemTimezone, withBlock } from "../lib/setup";
import { HoustonError } from "../lib/util";

type Change = { what: string; apply: () => void };

const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");
const write = (file: string, text: string) => (mkdirSync(dirname(file), { recursive: true }), writeFileSync(file, text));
const excludeLines = (file: string) => read(file).split("\n").map((l) => l.trim());

/** "owner/name=/path" or "owner/name=none" → [repo, path | null]. */
function parseOverride(text: string): [string, string | null] {
  const m = /^([\w.-]+\/[\w.-]+)=(.+)$/.exec(text);
  if (!m) throw new HoustonError(`--repo ${text}: write it as owner/name=/path/to/clone, or owner/name=none if it isn't on this machine.`);
  if (m[2] === "none") return [m[1], null];
  const dir = resolve(m[2].replace(/^~(?=\/|$)/, home()));
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new HoustonError(`--repo ${text}: ${dir} is not a folder on this machine.`);
  return [m[1], dir];
}

function planLink(opts: { overrides: string[]; global: boolean }): { changes: Change[]; local: Partial<Local>; missing: string[]; notes: string[] } {
  const team = loadTeam();
  const raw = readLocalRaw();
  const notes: string[] = [];
  const repos: Record<string, string | null> = { ...raw.repos };

  const overrides = new Map(opts.overrides.map(parseOverride));
  for (const repo of overrides.keys()) if (!projectOf(team, repo)) throw new HoustonError(`--repo ${repo}: that's not one of the team's repos in houston.yml.`);

  // Keep what's recorded unless the folder is gone; look for everything else.
  const wanted = teamRepos(team).map((r) => r.repo).filter((r) => !overrides.has(r) && (repos[r] === undefined || (repos[r] !== null && !existsSync(repos[r]!))));
  if (wanted.length) Object.assign(repos, findRepos(wanted));
  for (const [repo, dir] of overrides) repos[repo] = dir;

  const local: Partial<Local> = {
    user: raw.user ?? github().login(),
    timezone: raw.timezone ?? systemTimezone(),
    repos,
    ...(raw.schedule ? { schedule: raw.schedule } : {}),
  };
  if (!team.team.members.includes(local.user!)) notes.push(`${local.user} isn't in team.members in houston.yml yet. Ask a lead to add you; your runs work meanwhile.`);

  const changes: Change[] = [];
  const text = localText(local);
  if (read(paths.local) !== text) changes.push({ what: `write houston.local.yml`, apply: () => write(paths.local, text) });

  const missing: string[] = [];
  for (const { repo, project } of teamRepos(team)) {
    const dir = repos[repo];
    if (dir === null) continue;
    if (!dir || !existsSync(dir)) {
      missing.push(repo);
      continue;
    }
    const origin = originOf(dir);
    if (origin?.toLowerCase() !== repo.toLowerCase()) notes.push(`${dir} has origin ${origin ?? "(none)"}, not ${repo}. Linked anyway, as you asked.`);
    const pointer = join(dir, IN_CODE_REPO.pointer);
    const pointerBody = pointerText(repo, project);
    if (read(pointer) !== pointerBody) changes.push({ what: `${repo}: write ${pointer}`, apply: () => write(pointer, pointerBody) });
    const inbox = join(dir, IN_CODE_REPO.inbox);
    if (!existsSync(inbox)) changes.push({ what: `${repo}: create an empty ${inbox}`, apply: () => write(inbox, "") });
    const exclude = excludeFile(dir);
    const add = [IN_CODE_REPO.pointer, IN_CODE_REPO.inbox].filter((n) => !excludeLines(exclude).includes(n));
    if (add.length)
      changes.push({
        what: `${repo}: hide ${add.join(" and ")} from git in ${exclude}`,
        apply: () => {
          const before = read(exclude);
          write(exclude, `${before}${before && !before.endsWith("\n") ? "\n" : ""}${add.join("\n")}\n`);
        },
      });
  }

  const agents = agentsLocalText(team, local);
  if (read(paths.agentsLocal) !== agents) changes.push({ what: "write AGENTS.local.md (where each repo is on this machine)", apply: () => write(paths.agentsLocal, agents) });

  if (opts.global) {
    const file = globalFile();
    const next = withBlock(read(file), globalBlock());
    if (read(file) !== next) changes.push({ what: `write the Houston block in ${file}`, apply: () => write(file, next) });
  }

  // Runs commit unattended, so no passphrase prompt; and a symlink someone pushes stays a plain
  // file, so it can't point an agent at files elsewhere on this machine.
  if (git(["rev-parse", "--git-dir"]).ok)
    for (const [key, value] of [["commit.gpgsign", "false"], ["core.symlinks", "false"]])
      if (git(["config", "--local", "--get", key]).stdout !== value) changes.push({ what: `set git ${key} ${value} in the Houston repo`, apply: () => void git(["config", "--local", key, value]) });

  // The person is running setup by hand, so the core they have is the one they chose.
  if (!isTrusted()) changes.push({ what: "trust this Houston core for unattended runs", apply: () => void trustCore() });

  return { changes, local, missing, notes };
}

function planRemove(force: boolean): { changes: Change[]; notes: string[] } {
  const local = readLocalRaw();
  const changes: Change[] = [];
  const notes: string[] = [];
  for (const [repo, dir] of Object.entries(local.repos ?? {})) {
    if (!dir || !existsSync(dir)) continue;
    const gone: string[] = [];
    const pointer = join(dir, IN_CODE_REPO.pointer);
    if (existsSync(pointer)) changes.push({ what: `${repo}: delete ${pointer}`, apply: () => rmSync(pointer) }), gone.push(IN_CODE_REPO.pointer);
    const inbox = join(dir, IN_CODE_REPO.inbox);
    if (existsSync(inbox) && read(inbox).trim() && !force) notes.push(`Kept ${inbox}: it has notes in it. Add --force to delete it too.`);
    else {
      if (existsSync(inbox)) changes.push({ what: `${repo}: delete ${inbox}`, apply: () => rmSync(inbox) });
      gone.push(IN_CODE_REPO.inbox);
    }
    const exclude = excludeFile(dir);
    const lines = read(exclude).split("\n");
    const kept = lines.filter((l) => !gone.includes(l.trim()));
    if (kept.length !== lines.length) changes.push({ what: `${repo}: remove Houston's lines from ${exclude}`, apply: () => write(exclude, kept.join("\n")) });
  }
  if (existsSync(paths.agentsLocal)) changes.push({ what: "delete AGENTS.local.md", apply: () => rmSync(paths.agentsLocal) });
  const file = globalFile();
  const next = withBlock(read(file), null);
  if (read(file) !== next) changes.push({ what: `remove the Houston block from ${file}`, apply: () => write(file, next) });
  if (existsSync(paths.local)) notes.push("Kept houston.local.yml (your repo paths), so `houston link` can set you up again. Delete it if you're leaving the team.");
  if (local.schedule) notes.push(`Your scheduler still runs \`houston run\`: ${local.schedule}. Remove it there; Houston doesn't manage schedules.`);
  return { changes, notes };
}

export default {
  summary: "Set up this machine: link the team's repos, write your local files and the agent block",
  usage: `
houston link [--repo owner/name=/path]… [--dry-run] [--remove [--force]] [--no-global]

Finds the team's repos under your usual code folders (and HOUSTON_SCAN_DIRS), writes
houston.local.yml, a hidden .houston file and .houston-inbox.md in each repo, AGENTS.local.md,
and the Houston block in ~/.claude/CLAUDE.md. Running it again only fixes what changed.

  --repo owner/name=/path   use this clone (or =none: not on this machine)
  --dry-run                 print the plan and write nothing
  --remove                  undo it all (an inbox with notes is kept unless --force)
  --no-global               leave ~/.claude/CLAUDE.md alone`,
  async run(args) {
    const { values } = parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      options: {
        repo: { type: "string", multiple: true },
        "dry-run": { type: "boolean" },
        remove: { type: "boolean" },
        force: { type: "boolean" },
        "no-global": { type: "boolean" },
      },
    });
    const dry = Boolean(values["dry-run"]);
    let changes: Change[];
    let notes: string[];
    let missing: string[] = [];

    if (values.remove) {
      ({ changes, notes } = planRemove(Boolean(values.force)));
    } else {
      const plan = planLink({ overrides: values.repo ?? [], global: !values["no-global"] });
      ({ changes, notes, missing } = plan);
      console.log(`You: ${plan.local.user}, timezone ${plan.local.timezone}. Core ${await coreVersion()}.`);
      console.log("Repos:");
      for (const [repo, dir] of Object.entries(plan.local.repos ?? {})) console.log(`  ${repo}: ${dir ?? "not on this machine"}`);
      for (const repo of missing) console.log(`  ${repo}: not found`);
    }

    if (!changes.length) console.log(values.remove ? "Nothing of Houston's left to remove." : "Everything is already set up; nothing changed.");
    else if (dry) {
      console.log("\nPlan (nothing written yet; run again without --dry-run to apply):");
      for (const c of changes) console.log(`  - ${c.what}`);
      if (!values.remove && changes.some((c) => c.what.includes(globalFile()))) console.log(`\nThe block for ${globalFile()}:\n\n${globalBlock()}`);
    } else {
      console.log(values.remove ? "\nRemoved:" : "\nDone:");
      for (const c of changes) {
        c.apply();
        console.log(`  ✓ ${c.what}`);
      }
    }

    for (const repo of missing)
      notes.push(`Couldn't find ${repo} on this machine. Clone it and run \`houston link\` again, or point at it with \`houston link --repo ${repo}=/path\`, or \`--repo ${repo}=none\` if you don't work on it here.`);
    if (notes.length) console.log(`\n${notes.join("\n")}`);
    if (!values.remove && !dry) console.log("\nNext: `houston schedule` shows what to put in your scheduler, then `houston doctor` checks everything.");
  },
} satisfies Command;
