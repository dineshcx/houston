// Intake end to end: propose opens a PR without touching the person's checkout; apply makes the
// changes through the issue rules, records them, and never repeats them.
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FakeData } from "../src/lib/github";

const CLI = join(import.meta.dir, "../src/cli.ts");
const tmp = mkdtempSync(join(tmpdir(), "houston-intake-test-"));
// The bare remote's path ends in github.com/acme/houston.git, so houstonRepo() reads it as acme/houston.
const bare = join(tmp, "github.com/acme/houston.git");
const work = join(tmp, "work");
const other = join(tmp, "other");
const fake = join(tmp, "github.json");
const env = {
  ...process.env,
  HOME: tmp,
  HOUSTON_ROOT: work,
  HOUSTON_FAKE_GITHUB: fake,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const today = new Date().toLocaleDateString("sv");
const name = `${today}-daily-sync-13-nov`;
const notes = "projects/storefront/daily/2026-11-13/_page.md";

function sh(cmd: string[], cwd = work) {
  const p = Bun.spawnSync(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
}
const git = (args: string[], cwd = work) => {
  const r = sh(["git", "-c", "commit.gpgsign=false", ...args], cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.err}`);
  return r.out;
};
const houston = (...args: string[]) => sh(["bun", CLI, ...args]);
const data = (): FakeData => JSON.parse(readFileSync(fake, "utf8"));
const write = (file: string, text: string) => (mkdirSync(join(file, ".."), { recursive: true }), writeFileSync(file, text));

const team = `houston: 1
core: 0.1.0
team: { name: Web, leads: [ana], members: [ana, raj] }
projects:
  storefront: { name: Storefront, repos: [acme/web, acme/api], cadences: [] }
`;

const proposal = `project: storefront
changes:
  - create: { repo: acme/web, title: "Retry stuck runs after 10 min", goal: "No run stays stuck", assignee: raj, priority: p1, kind: bug, raised_by: ana }
  - create: { repo: acme/api, title: "Expose run heartbeat", parent: 1 }
  - update: { issue: acme/web#88, add_decision: "Drop CSV export, JSON only", status: in-progress }
  - comment: { issue: acme/api#412, body: "Blocked until the heartbeat ships" }
skipped:
  - "Maybe look at caching: nobody owned it"
`;

/** Merges a branch on the remote, the way clicking Merge on GitHub would. */
function mergeOnRemote(branch: string) {
  git(["pull", "--quiet"], other);
  git(["merge", "--quiet", "--no-edit", `origin/${branch}`], other);
  git(["push", "--quiet"], other);
}

beforeAll(() => {
  mkdirSync(bare, { recursive: true });
  git(["init", "--quiet", "--bare", "-b", "main", bare], tmp);
  git(["clone", "--quiet", bare, work], tmp);
  write(join(work, "houston.yml"), team);
  write(join(work, ".gitignore"), ".houston-local/\n");
  write(join(work, "README.md"), "hello\n");
  git(["add", "."]);
  git(["commit", "--quiet", "-m", "init"]);
  git(["push", "--quiet", "-u", "origin", "main"]);
  git(["clone", "--quiet", bare, other], tmp);
  const issue = (repo: string, number: number, body = "") => ({ repo, number, title: `#${number}`, state: "open", body, labels: ["status:todo"], assignees: [], url: `https://github.com/${repo}/issues/${number}`, updatedAt: "2026-11-01T00:00:00Z" });
  writeFileSync(fake, JSON.stringify({ login: "ana", issues: [issue("acme/web", 88, "People's text"), issue("acme/api", 412)] }));
});

describe("houston propose", () => {
  test("refuses a proposal that breaks the schema or the team's setup", () => {
    write(join(work, notes), "notes");
    const bad = join(work, ".houston-local/bad.yml");
    write(bad, `project: storefront\ncolour: red\nchanges:\n  - create: { repo: other/repo, title: X, parent: 3 }\n  - comment: { issue: acme/api#1, body: hi, when: now }\n`);
    const r = houston("propose", "--title", "T", "--notes", notes, "--proposal", bad, "--dry-run");
    expect(r.code).toBe(1);
    expect(r.err).toContain("colour: unknown key");
    expect(r.err).toContain("other/repo is not one of the team's repos");
    expect(r.err).toContain("change 1.parent: 3 should be the number of an earlier create");
    expect(r.err).toContain("change 2.comment.when: unknown key");
  });

  test("opens the PR from a worktree, leaving the person's branch and work alone", () => {
    write(join(work, "README.md"), "my unsaved edit\n");
    write(join(work, notes), "## Decisions\n- JSON only\n");
    const p = join(work, ".houston-local/intake.yml");
    write(p, proposal);
    const r = houston("propose", "--title", "Daily sync 13 Nov", "--notes", notes, "--proposal", p);
    expect(r.err).toBe("");
    expect(r.out).toContain("Opened https://github.com/acme/houston/pull/1");

    expect(git(["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(readFileSync(join(work, "README.md"), "utf8")).toBe("my unsaved edit\n");
    // The untracked notes moved into the PR, so pulling after the merge can't collide with them.
    expect(existsSync(join(work, notes))).toBe(false);
    expect(git(["worktree", "list"]).split("\n").length).toBe(1);
    expect(git(["branch", "--list", "intake/*"])).toBe("");

    const pr = data().pulls[0];
    expect(pr).toMatchObject({ branch: `intake/${name}`, labels: ["houston:intake"], title: "Daily sync 13 Nov: notes + 4 issue changes" });
    expect(pr.body).toContain("- [ ] 2. Create in acme/api: **Expose run heartbeat** · sub-issue of change 1");
    expect(pr.body).toContain("Close** to discard");
    const pushed = git(["show", `intake/${name}:proposals/${name}.yml`], bare);
    expect(pushed).toContain('owner: "ana"');
    expect(pushed).toContain(`source: "${notes}"`);
    expect(git(["show", `intake/${name}:${notes}`], bare)).toContain("JSON only");
  });
});

describe("houston propose, notes on a page that's already in the repo", () => {
  const page = "projects/storefront/daily/2026-11-14/_page.md";
  test("pulls first, so the PR keeps teammates' additions, then puts the page back as it is in the repo", () => {
    write(join(work, page), "# Daily\n\n## Agenda\n\n## Notes\n\nnothing yet\n\n## Decisions\n");
    git(["add", page]);
    git(["commit", "--quiet", "-m", "page"]);
    git(["push", "--quiet"]);
    // A teammate adds to the agenda after this checkout last pulled.
    git(["pull", "--quiet"], other);
    write(join(other, page), "# Daily\n\n## Agenda\n- raj: the heartbeat\n\n## Notes\n\nnothing yet\n\n## Decisions\n");
    git(["commit", "--quiet", "-am", "raj's agenda"], other);
    git(["push", "--quiet"], other);

    write(join(work, page), "# Daily\n\n## Agenda\n\n## Notes\n\nnothing yet\n\n## Decisions\n- JSON only\n");
    const p = join(work, ".houston-local/page.yml");
    write(p, "project: storefront\nchanges: []\n");
    const r = houston("propose", "--title", "Daily sync 14 Nov", "--notes", page, "--proposal", p);
    expect(r.err).toBe("");
    expect(r.out).toContain(`Moved your changes to ${page} into the pull request`);

    const pushed = git(["show", `intake/${today}-daily-sync-14-nov:${page}`], bare);
    expect(pushed).toContain("- raj: the heartbeat");
    expect(pushed).toContain("- JSON only");
    // The checkout is clean, so pulling after the merge can't collide.
    expect(git(["status", "--porcelain", "--", page])).toBe("");
    expect(readFileSync(join(work, page), "utf8")).toContain("- raj: the heartbeat");
    expect(readFileSync(join(work, page), "utf8")).not.toContain("JSON only");
  });
});

describe("houston apply", () => {
  test("--pending applies only my merged proposals, through the issue rules", () => {
    mergeOnRemote(`intake/${name}`);
    // Raj's merged proposal must wait for Raj.
    write(join(other, "proposals/2026-11-13-rajs.yml"), "title: Raj's\nowner: raj\nproject: storefront\nsource: x.md\nchanges:\n  - comment: { issue: acme/api#412, body: from raj }\n");
    git(["add", "."], other);
    git(["commit", "--quiet", "-m", "raj"], other);
    git(["push", "--quiet"], other);
    const r = houston("apply", "--pending");
    expect(r.err).toBe("");
    expect(r.out).toContain(`${name}: applied 4 change(s)`);

    const after = data();
    const created = after.issues.find((i) => i.repo === "acme/web" && i.number === 89)!;
    expect(created.labels).toEqual(["status:todo", "p1", "kind:bug"]);
    expect(created.assignees).toEqual(["raj"]);
    expect(created.body).toStartWith("<!-- houston:summary -->\n**Goal:** No run stays stuck\n");
    expect(created.body).toContain(`**Raised by:** @ana in [Daily sync 13 Nov](https://github.com/acme/houston/blob/main/${notes})`);
    expect(created.body).toContain("### Acceptance checks\n<!-- /houston:summary -->");
    expect(after.subIssues).toEqual([["acme/web#89", "acme/api#413"]]);

    const updated = after.issues.find((i) => i.repo === "acme/web" && i.number === 88)!;
    expect(updated.body).toContain("### Decisions\n- Drop CSV export, JSON only ([Daily sync 13 Nov]");
    expect(updated.body).toEndWith("People's text");
    expect(updated.labels).toEqual(["status:in-progress"]);
    expect(after.issues.find((i) => i.number === 412)!.comments).toEqual(["Blocked until the heartbeat ships"]);

    expect(existsSync(join(work, `proposals/${name}.yml`))).toBe(false);
    const record = readFileSync(join(work, `proposals/applied/${name}.yml`), "utf8");
    expect(record).toContain('by: "ana"');
    expect(record).toContain('- "created acme/api#413 https://github.com/acme/api/issues/413, sub-issue of acme/web#89"');
    expect(git(["show", `main:proposals/applied/${name}.yml`], bare)).toContain("applied:");
    expect((after.pulls.find((p) => p.repo === "acme/houston") as { comments?: string[] }).comments![0]).toContain("Applied by @ana:\n\n1. created acme/web#89");
    expect(existsSync(join(work, "proposals/2026-11-13-rajs.yml"))).toBe(true);
  });

  test("running it again changes nothing", () => {
    const writes = data().writes.length;
    expect(houston("apply", "--pending").out).toBe("No merged proposals waiting for @ana.");
    expect(houston("apply", `proposals/${name}.yml`).out).toBe(`${name}: already applied`);
    expect(data().writes.length).toBe(writes);
  });

  test("a failure midway is recorded, and the retry continues without duplicating", () => {
    git(["pull", "--quiet"], other);
    write(join(other, "proposals/half.yml"), "title: Half\nowner: ana\nproject: storefront\nsource: x.md\nchanges:\n  - create: { repo: acme/web, title: First }\n  - comment: { issue: acme/web#999, body: hi }\n");
    git(["add", "."], other);
    git(["commit", "--quiet", "-m", "half"], other);
    git(["push", "--quiet"], other);
    const r = houston("apply", "proposals/half.yml");
    expect(r.code).toBe(1);
    expect(r.err).toContain("applied 1 of 2 changes, then change 2 failed");
    expect(readFileSync(join(work, "proposals/half.yml"), "utf8")).toContain('- "created acme/web#90');

    const d = data();
    d.issues.push({ repo: "acme/web", number: 999, title: "x", state: "open", body: "", labels: [], assignees: [], url: "", updatedAt: "" });
    writeFileSync(fake, JSON.stringify(d));
    expect(houston("apply", "proposals/half.yml").code).toBe(0);
    expect(data().issues.filter((i) => i.title === "First").length).toBe(1);
  });

  test("create_issue: never is refused", () => {
    writeFileSync(join(work, "houston.yml"), `${team}rules: { create_issue: never }\n`);
    write(join(work, notes), "notes");
    const p = join(work, ".houston-local/intake.yml");
    const r = houston("propose", "--title", "Again", "--notes", notes, "--proposal", p, "--dry-run");
    writeFileSync(join(work, "houston.yml"), team);
    expect(r.code).toBe(1);
    expect(r.err).toContain("change 1: the team's rules say Houston doesn't create issues (rules.create_issue: never)");
  });
});

test("a team's templates/issue.md shapes new issues' summaries, and the next step is never empty", () => {
  git(["pull", "--quiet"], other);
  write(join(other, "templates/issue.md"), "<!-- ours -->\n<!-- houston:summary -->\n**Why:** {{goal}}\n**From:** {{raised_by}}\n**Next step:** {{next_step}}\n### Risks\n<!-- /houston:summary -->\n");
  write(join(other, "proposals/tpl.yml"), "title: Tpl\nowner: ana\nproject: storefront\nsource: x.md\nchanges:\n  - create: { repo: acme/web, title: Templated }\n");
  git(["add", "."], other);
  git(["commit", "--quiet", "-m", "template"], other);
  git(["push", "--quiet"], other);
  expect(houston("apply", "proposals/tpl.yml").code).toBe(0);
  const body = data().issues.find((i) => i.title === "Templated")!.body;
  expect(body).toStartWith("<!-- houston:summary -->\n**Why:** Templated\n**From:** @ana in [Tpl]");
  expect(body).toContain("**Next step:** not decided yet\n### Risks\n<!-- /houston:summary -->");
  expect(body).not.toContain("<!-- ours -->");
});
