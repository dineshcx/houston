// Personal setup and lifecycle: link, validate, schedule times, skill overrides and update.
// Everything runs against a temporary HOME, Houston repo and code repos; GitHub is a fake file.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCadence } from "../src/lib/cadence";
import { validateTeam, type Team } from "../src/lib/config";
import { blockRoots, suggestRuns, withBlock, BLOCK_BEGIN, BLOCK_END } from "../src/lib/setup";

const CLI = join(import.meta.dir, "../src/cli.ts");
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "houston-setup-")));
const HOME = join(tmp, "home");
const ROOT = join(tmp, "team-houston");
const FAKE = join(tmp, "github.json");

const HOUSTON_YML = `houston: 1
core: 0.1.0 # pinned core
team: { name: Web team, leads: [ana], members: [ana, raj] }
projects:
  storefront:
    name: Storefront
    repos: [Acme/Web, acme/api, acme/missing]
    cadences: [daily]
`;
const DAILY = `---\ntitle: Daily standup\nschedule: "Mon-Fri 10:00"\nperiod: day\n---\n## Done\n`;

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
};

function makeRepo(dir: string, origin?: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "--quiet", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "T");
  if (origin) git(dir, "remote", "add", "origin", origin);
}

/** A Houston repo with a team and a stand-in core, so trusting it has a CLI to copy. */
function makeHouston(dir: string, yml: string) {
  makeRepo(dir);
  writeFileSync(join(dir, "houston.yml"), yml);
  mkdirSync(join(dir, "cadences"));
  writeFileSync(join(dir, "cadences", "daily.md"), DAILY);
  writeFileSync(join(dir, ".gitignore"), "houston.local.yml\nAGENTS.local.md\n.houston-local/\n");
  mkdirSync(join(dir, ".houston", "bin"), { recursive: true });
  writeFileSync(join(dir, ".houston", "bin", "houston"), "#!/bin/sh\n");
  git(dir, "add", "-A");
  git(dir, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "team");
}

function houston(args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawnSync(["bun", CLI, ...args], {
    env: { ...process.env, HOME, HOUSTON_ROOT: ROOT, HOUSTON_FAKE_GITHUB: FAKE, HOUSTON_SCAN_DIRS: "", TZ: "Europe/London", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
}

const read = (f: string) => readFileSync(f, "utf8");
const web = join(HOME, "code", "web");
const api = join(HOME, "Repo", "acme", "api");

beforeAll(() => {
  makeHouston(ROOT, HOUSTON_YML);
  makeRepo(web, "https://github.com/acme/web.git"); // case differs from houston.yml on purpose
  makeRepo(api, "git@github.com:acme/api.git");
  makeRepo(join(HOME, "code", "node_modules", "dep"), "https://github.com/acme/missing.git"); // never scanned
  mkdirSync(join(HOME, ".claude"), { recursive: true });
  writeFileSync(join(HOME, ".claude", "CLAUDE.md"), "# My own notes\nKeep this.\n");
  writeFileSync(FAKE, JSON.stringify({ login: "ana" }));
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("link", () => {
  test("--dry-run prints the plan and writes nothing", () => {
    const r = houston(["link", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Acme/Web: ${web}`);
    expect(r.out).toContain(BLOCK_BEGIN);
    expect(existsSync(join(ROOT, "houston.local.yml"))).toBe(false);
    expect(existsSync(join(web, ".houston"))).toBe(false);
    expect(read(join(HOME, ".claude", "CLAUDE.md"))).toBe("# My own notes\nKeep this.\n");
  });

  test("finds the repos, links them, and a second run changes nothing", () => {
    const first = houston(["link"]);
    expect(first.code).toBe(0);
    expect(first.out).toContain("Couldn't find acme/missing");
    const local = Bun.YAML.parse(read(join(ROOT, "houston.local.yml"))) as any;
    expect(local).toMatchObject({ user: "ana", timezone: "Europe/London", repos: { "Acme/Web": web, "acme/api": api } });
    expect(read(join(web, ".houston"))).toContain(`houston: ${ROOT}\nproject: storefront\nrepo: Acme/Web`);
    expect(read(join(api, ".houston-inbox.md"))).toBe("");
    expect(read(join(ROOT, "AGENTS.local.md"))).toContain(`acme/api (storefront): \`${api}\``);
    expect(git(ROOT, "config", "commit.gpgsign")).toBe("false");

    writeFileSync(join(web, ".houston-inbox.md"), "- 10:00 fixed checkout (acme/web#1)\n");
    const second = houston(["link"]);
    expect(second.out).toContain("nothing changed");
    expect(read(join(web, ".houston-inbox.md"))).toContain("fixed checkout");
    expect(read(join(web, ".git/info/exclude")).match(/^\.houston$/gm)?.length).toBe(1);
    expect(read(join(web, ".git/info/exclude")).match(/^\.houston-inbox\.md$/gm)?.length).toBe(1);
    const claude = read(join(HOME, ".claude", "CLAUDE.md"));
    expect(claude.startsWith("# My own notes\nKeep this.\n")).toBe(true);
    expect(claude.split(BLOCK_BEGIN).length).toBe(2);
    expect(blockRoots(claude)).toEqual([ROOT]);
    // The agent runs the trusted copy, never the core a pull just brought in.
    expect(claude).toContain("<houston>/.houston-local/core/bin/houston run --if-due --quiet");
    expect(existsSync(join(ROOT, ".houston-local/core/bin/houston"))).toBe(true);

    // Both scheduler examples give the run the PATH it needs (cron and agent apps start with a bare one).
    const schedule = houston(["schedule"]).out;
    expect(schedule).toMatch(/PATH=\S+ \S+\/\.houston-local\/core\/bin\/houston run/);
    expect(schedule).toMatch(/with bun, claude, gh and git on its PATH \(\S+\)/);
  });

  test("the block lists both teams' Houston repos, and removing one keeps the other", () => {
    const second = join(tmp, "data-houston");
    makeHouston(second, "houston: 1\ncore: 0.1.0\nteam: { name: Data, leads: [ana], members: [ana] }\nprojects:\n  etl: { name: ETL, repos: [acme/etl], cadences: [daily] }\n");
    expect(houston(["link", "--repo", "acme/etl=none"], { HOUSTON_ROOT: second }).code).toBe(0);
    const claude = () => read(join(HOME, ".claude", "CLAUDE.md"));
    expect(blockRoots(claude())).toEqual([ROOT, second]);
    expect(claude().split(BLOCK_BEGIN).length).toBe(2);
    expect(houston(["link"]).out).toContain("nothing changed");

    expect(houston(["link", "--remove"], { HOUSTON_ROOT: second }).code).toBe(0);
    expect(blockRoots(claude())).toEqual([ROOT]);
  });

  test("--repo overrides what was found; =none marks a repo as not on this machine", () => {
    const r = houston(["link", "--repo", "acme/missing=none"]);
    expect(r.out).not.toContain("Couldn't find");
    expect((Bun.YAML.parse(read(join(ROOT, "houston.local.yml"))) as any).repos["acme/missing"]).toBeNull();
    expect(houston(["link", "--repo", "acme/other=/tmp"]).out).toContain("not one of the team's repos");
    // A path through a symlink (/tmp vs /private/tmp on macOS) is recorded as its real path.
    houston(["link", "--repo", `acme/api=${api.replace(realpathSync(tmpdir()), tmpdir())}`]);
    expect((Bun.YAML.parse(read(join(ROOT, "houston.local.yml"))) as any).repos["acme/api"]).toBe(api);
  });

  test("--remove cleans up, keeping an inbox that has notes", () => {
    const r = houston(["link", "--remove"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Kept " + join(web, ".houston-inbox.md"));
    expect(existsSync(join(web, ".houston"))).toBe(false);
    expect(existsSync(join(api, ".houston-inbox.md"))).toBe(false);
    expect(read(join(api, ".git/info/exclude"))).not.toContain(".houston");
    expect(read(join(web, ".git/info/exclude"))).toContain(".houston-inbox.md");
    expect(read(join(web, ".git/info/exclude"))).not.toMatch(/^\.houston$/m);
    expect(existsSync(join(ROOT, "AGENTS.local.md"))).toBe(false);
    expect(read(join(HOME, ".claude", "CLAUDE.md"))).toBe("# My own notes\nKeep this.\n");
  });
});

test("the global block is replaced in place, never duplicated", () => {
  const once = withBlock("mine\n", `${BLOCK_BEGIN}\nv1\n${BLOCK_END}`);
  const twice = withBlock(once + "\nafter\n", `${BLOCK_BEGIN}\nv2\n${BLOCK_END}`);
  expect(twice).toBe(`mine\n\n${BLOCK_BEGIN}\nv2\n${BLOCK_END}\n\nafter\n`);
  expect(withBlock(twice, null)).toBe("mine\n\nafter\n");
  // A list line in the user's own text isn't a Houston repo.
  expect(blockRoots("- `/elsewhere`\n" + twice)).toEqual([]);
});

test("validate lists every problem and exits 1, ignoring a README in cadences/", () => {
  writeFileSync(join(ROOT, "cadences", "README.md"), "# Our cadences\nNot a cadence.\n");
  writeFileSync(join(ROOT, "cadences", "weekly.md"), "---\nschedule: someday\n---\n");
  const r = houston(["validate"]);
  expect(r.code).toBe(1);
  expect(r.out).toContain("cadences/weekly.md");
  expect(r.out).not.toContain("README");
  rmSync(join(ROOT, "cadences", "weekly.md"));
  expect(houston(["validate"]).code).toBe(0);
});

test("validate refuses an issue template with a placeholder Houston can't fill", () => {
  mkdirSync(join(ROOT, "templates"), { recursive: true });
  writeFileSync(join(ROOT, "templates", "issue.md"), "<!-- houston:summary -->\n**Goal:** {{goal}}\n**Owner:** {{owner}}\n<!-- /houston:summary -->\n");
  const r = houston(["validate"]);
  rmSync(join(ROOT, "templates"), { recursive: true });
  expect(r.code).toBe(1);
  expect(r.out).toContain("templates/issue.md uses {{owner}}");
});

test("every preset's cadences validate with a minimal houston.yml", () => {
  const presets = join(import.meta.dir, "../presets");
  for (const preset of readdirSync(presets)) {
    const dir = join(presets, preset, "cadences");
    const names = readdirSync(dir).map((f) => f.replace(/\.md$/, ""));
    for (const n of names) expect(() => parseCadence(n, read(join(dir, `${n}.md`)))).not.toThrow();
    const { errors } = validateTeam({ houston: 1, core: "0.1.0", team: { name: "T", leads: ["a"], members: ["a"] }, projects: { p: { name: "P", repos: ["a/b"], cadences: names } } }, names);
    expect(errors).toEqual([]);
  }
});

test("doctor on a fresh Houston repo says to ask the agent to set it up, first", () => {
  const fresh = join(tmp, "fresh");
  makeRepo(fresh);
  const r = houston(["doctor"], { HOUSTON_ROOT: fresh });
  expect(r.code).toBe(1);
  expect(r.out.split("\n")[0]).toContain('say "set me up" to your agent here');
  expect(r.out).not.toContain("houston validate");
});

test("help groups the commands by when people use them", () => {
  const out = houston(["help"]).out;
  const at = (s: string) => out.indexOf(s);
  for (const g of ["Every day:", "Setting up:", "Your team's setup:", "Used by agents and skills:"]) expect(at(g)).toBeGreaterThan(-1);
  expect(at("Every day:")).toBeLessThan(at("  run "));
  expect(at("  run ")).toBeLessThan(at("Setting up:"));
  expect(at("Used by agents and skills:")).toBeLessThan(at("  propose "));
  const wrong = houston(["link", "--bogus"]);
  expect(wrong.code).toBe(1);
  expect(wrong.out).toContain("Run `houston help link`");
});

test("schedule suggests runs an hour before, at the publish deadline, and through the day", () => {
  const team = validateTeam({ houston: 1, core: "0.1.0", team: { name: "T", leads: ["a"], members: ["a"] }, projects: { p: { name: "P", repos: ["a/b"] } } }).team as Team;
  const runs = suggestRuns([parseCadence("daily", DAILY)], team);
  expect(runs.map((r) => r.time)).toEqual(["09:00", "09:45", "12:00", "15:00", "18:00"]);
  expect(runs.every((r) => r.days.join() === "1,2,3,4,5")).toBe(true);
  expect(runs[1].why).toEqual(["Daily standup publish deadline"]);
});

test("a team skill overrides the core skill of the same name", () => {
  expect(houston(["skill", "set-me-up", "--path"]).out.trim()).toEndWith(".houston/skills/set-me-up/SKILL.md");
  expect(houston(["skill", "set-me-up"]).out).toMatch(/^\(skill: \S+\/\.houston\/skills\/set-me-up\/SKILL\.md, core\)\n\n---\nname: set-me-up/);
  mkdirSync(join(ROOT, "skills", "set-me-up"), { recursive: true });
  writeFileSync(join(ROOT, "skills", "set-me-up", "SKILL.md"), "ours");
  expect(houston(["skill", "set-me-up", "--path"]).out.trim()).toBe(join(ROOT, "skills", "set-me-up", "SKILL.md"));
  expect(houston(["skill", "set-me-up"]).out).toBe(`(skill: ${join(ROOT, "skills", "set-me-up", "SKILL.md")}, team override)\n\nours`);
  expect(houston(["skill"]).out).toMatch(/set-me-up .*\(team override\)/);
  expect(houston(["skill", "nope"]).code).toBe(1);
});

test("update brings a newer core in on its own branch and bumps core:", () => {
  const template = join(tmp, "template");
  makeRepo(template);
  mkdirSync(join(template, ".houston", "src"), { recursive: true });
  writeFileSync(join(template, ".houston", "VERSION"), "0.2.0\n");
  writeFileSync(join(template, ".houston", "src", "new.ts"), "// new core\n");
  git(template, "add", "-A");
  git(template, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "0.2.0");

  const r = houston(["update", "--from", "acme/houston"], { HOUSTON_TEMPLATE_URL: template });
  expect(r.code).toBe(0);
  expect(git(ROOT, "branch", "--show-current")).toBe("main");
  expect(read(join(ROOT, "houston.yml"))).toContain("core: 0.1.0 # pinned core");
  expect(git(ROOT, "show", "houston-update-0.2.0:houston.yml")).toContain("core: 0.2.0 # pinned core");
  expect(git(ROOT, "show", "houston-update-0.2.0:.houston/src/new.ts")).toBe("// new core");

  const again = houston(["update", "--from", "acme/houston"], { HOUSTON_TEMPLATE_URL: template });
  expect(again.code).toBe(1); // the branch exists already
  writeFileSync(join(template, ".houston", "VERSION"), "0.0.9\n");
  git(template, "-c", "commit.gpgsign=false", "commit", "--quiet", "-am", "older");
  expect(houston(["update", "--from", "acme/houston"], { HOUSTON_TEMPLATE_URL: template }).out).toContain("Nothing to update");
});
