// The run end to end, in a temp Houston repo with a bare remote, a linked code repo, a fake GitHub
// and a scripted agent: draft, publish, quiet runs, deadline publishing and drafts the CLI refuses.
import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coreHash } from "../src/lib/core";

const CLI = join(import.meta.dir, "../src/cli.ts");
const today = () => new Date().toISOString().slice(0, 10);

const AGENT = `#!/bin/sh
cat > "$OUT/prompt.txt"
echo called >> "$OUT/agent-calls"
d=$(date -u +%F)
printf '## Done\\n- acme/web#12 Checkout retries back off\\n' | "$HOUSTON_BIN" draft add day "$d" || exit 1
printf '## Done\\n- acme/web#12 Checkout retries back off\\n' | "$HOUSTON_BIN" draft add page "storefront/daily/$d" || exit 1
printf '**Goal:** Retries back off\\n**State:** done\\n' | "$HOUSTON_BIN" draft add summary acme/web#12 || exit 1
printf 'status:in-review\\n' | "$HOUSTON_BIN" draft add labels acme/web#12 || exit 1
`;

/** Git and the CLI see a temp HOME, so the person's own git config (signing, hooks) never applies. */
const HOME = mkdtempSync(join(tmpdir(), "houston-home-"));

function sh(cwd: string, cmd: string[], env: Record<string, string> = {}) {
  const p = Bun.spawnSync(cmd, { cwd, env: { ...process.env, HOME, GIT_CONFIG_NOSYSTEM: "1", ...env } });
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${p.stderr}`);
}

/** A fresh Houston repo (pushed to a bare remote), a linked code repo and a fake GitHub. */
function setup() {
  const tmp = mkdtempSync(join(tmpdir(), "houston-run-"));
  const root = join(tmp, "houston");
  const web = join(tmp, "web");
  const fake = join(tmp, "github.json");
  const id = { GIT_AUTHOR_NAME: "Ana", GIT_AUTHOR_EMAIL: "ana@example.com", GIT_COMMITTER_NAME: "Ana", GIT_COMMITTER_EMAIL: "ana@example.com" };

  sh(tmp, ["git", "init", "-q", "--bare", "remote.git"]);
  mkdirSync(join(root, "cadences"), { recursive: true });
  writeFileSync(
    join(root, "houston.yml"),
    `houston: 1
core: 0.1.0
team: { name: Web, leads: [ana], members: [ana] }
projects:
  storefront: { name: Storefront, repos: [acme/web, acme/api], cadences: [daily] }
`,
  );
  writeFileSync(join(root, "cadences/daily.md"), "---\ntitle: Daily standup\nschedule: daily 10:00\nperiod: day\n---\n## Done\n## Doing\n## Blocked\n## Other\n");
  writeFileSync(join(root, ".gitignore"), "houston.local.yml\n.houston-local/\n");
  writeFileSync(join(root, "houston.local.yml"), `user: ana\ntimezone: UTC\nrepos:\n  acme/web: ${web}\n  acme/api: null\n`);
  sh(root, ["git", "init", "-q", "-b", "main"]);
  sh(root, ["git", "config", "user.email", "ana@example.com"]);
  sh(root, ["git", "config", "user.name", "Ana"]);
  sh(root, ["git", "remote", "add", "origin", join(tmp, "remote.git")]);
  sh(root, ["git", "add", "-A"]);
  sh(root, ["git", "commit", "-q", "-m", "start"], id);
  sh(root, ["git", "push", "-q", "-u", "origin", "main"]);

  mkdirSync(web);
  sh(web, ["git", "init", "-q", "-b", "main"]);
  sh(web, ["git", "config", "user.email", "ana@example.com"]);
  // Ten minutes ago, so the first run's window takes it and the next one doesn't.
  const earlier = new Date(Date.now() - 600_000).toISOString();
  sh(web, ["git", "commit", "-q", "--allow-empty", "-m", "Back off checkout retries #12"], { ...id, GIT_AUTHOR_DATE: earlier, GIT_COMMITTER_DATE: earlier });
  writeFileSync(join(web, ".git/info/exclude"), ".houston-inbox.md\n");
  writeFileSync(join(web, ".houston-inbox.md"), "- 09:00 retries done, needs review (acme/web#12)\n");

  writeFileSync(
    fake,
    JSON.stringify({
      login: "ana",
      issues: [{ repo: "acme/web", number: 12, title: "Checkout retries", state: "open", body: "Customer report below.", labels: ["status:todo"], assignees: ["ana"], url: "", updatedAt: "2026-11-01T00:00:00Z" }],
    }),
  );
  writeFileSync(join(tmp, "agent.sh"), AGENT);
  mkdirSync(join(root, ".houston-local"));
  writeFileSync(join(root, ".houston-local/state.json"), JSON.stringify({ trusted_core: coreHash() }));

  const env = { HOUSTON_ROOT: root, HOUSTON_FAKE_GITHUB: fake, HOME, GIT_CONFIG_NOSYSTEM: "1", HOUSTON_NO_NOTIFY: "1", HOUSTON_AGENT: `sh ${join(tmp, "agent.sh")}`, OUT: tmp };
  const cli = (args: string[], input?: string) => {
    const p = Bun.spawnSync(["bun", CLI, ...args], { env: { ...process.env, ...env }, stdin: input === undefined ? "ignore" : new TextEncoder().encode(input) });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  const state = () => JSON.parse(readFileSync(join(root, ".houston-local/state.json"), "utf8"));
  const github = () => JSON.parse(readFileSync(fake, "utf8"));
  const agentCalls = () => (existsSync(join(tmp, "agent-calls")) ? readFileSync(join(tmp, "agent-calls"), "utf8").split("\n").filter(Boolean).length : 0);
  return { tmp, root, web, cli, state, github, agentCalls, draft: join(root, ".houston-local/draft.md"), dayLog: join(root, `people/ana/${today()}.md`) };
}

describe("houston run", () => {
  test("drafts, publishes, then a quiet run makes no agent call", () => {
    const h = setup();
    const run = h.cli(["run"]);
    expect(run.err).toBe("");
    expect(run.out).toContain("Your draft is ready");
    const prompt = readFileSync(join(h.tmp, "prompt.txt"), "utf8");
    expect(prompt).toContain("## acme/web#12 Checkout retries");
    expect(prompt).toContain(`## page storefront/daily/${today()}`);
    expect(prompt).toContain("<untrusted source=\"inbox acme/web\">09:00 retries done");
    expect(readFileSync(h.draft, "utf8")).toContain("<!-- houston:labels acme/web#12 -->\nstatus:in-review");
    const windowEnd = h.state().draft.window_end;
    expect(h.state().draft.deadline).toBeString();

    const pub = h.cli(["publish"]);
    expect(pub.err).toBe("");
    const day = readFileSync(h.dayLog, "utf8");
    expect(day).toContain("- acme/web#12 Checkout retries back off");
    expect(day).toMatch(/\n_run \d\d:\d\d · sources: github ok, git ok, inbox ok, sessions ok_\n$/);
    expect(existsSync(join(h.root, `projects/storefront/daily/${today()}/ana.md`))).toBe(true);
    expect(existsSync(join(h.root, `projects/storefront/daily/${today()}/_page.md`))).toBe(true);
    const pushed = Bun.spawnSync(["git", "--git-dir", join(h.tmp, "remote.git"), "log", "main", "--format=%s"], { env: { ...process.env, HOME } }).stdout.toString();
    expect(pushed).toContain("houston: ana run");
    const issue = h.github().issues[0];
    expect(issue.body).toBe("<!-- houston:summary -->\n**Goal:** Retries back off\n**State:** done\n<!-- /houston:summary -->\n\nCustomer report below.");
    expect(issue.labels).toEqual(["status:in-review"]);
    expect(readFileSync(join(h.web, ".houston-inbox.md"), "utf8")).toBe("");
    expect(h.state()).toMatchObject({ last_publish: windowEnd, last_run: { outcome: "published" } });
    expect(h.state().draft).toBeUndefined();
    expect(existsSync(h.draft)).toBe(false);

    const quiet = h.cli(["run"]);
    expect(quiet.out).toContain("Nothing new");
    expect(h.agentCalls()).toBe(1);
    expect(h.state().last_run.outcome).toBe("quiet");
  }, 60_000);

  test("a draft past its deadline publishes, marked not reviewed", () => {
    const h = setup();
    h.cli(["run"]);
    const file = join(h.root, ".houston-local/state.json");
    writeFileSync(file, JSON.stringify({ ...h.state(), draft: { ...h.state().draft, deadline: "2000-01-01T00:00:00Z" } }));
    const run = h.cli(["run"]);
    expect(run.out).toContain("Published your draft");
    expect(readFileSync(h.dayLog, "utf8")).toContain("· not reviewed_");
    expect(h.agentCalls()).toBe(1);
  }, 60_000);

  test("an edited draft waits for the person and is never overwritten", () => {
    const h = setup();
    h.cli(["run"]);
    appendFileSync(h.draft, "- my own note\n");
    const before = readFileSync(h.draft, "utf8");
    const run = h.cli(["run"]);
    expect(run.out).toContain("waiting for you");
    expect(readFileSync(h.draft, "utf8")).toBe(before);
    expect(h.agentCalls()).toBe(1);
  }, 60_000);

  test("refuses sections for other repos and frozen periods, at add and at publish", () => {
    const h = setup();
    const frozen = h.cli(["draft", "add", "page", "storefront/daily/2020-01-01"], "## Done\n- x");
    expect(frozen.code).toBe(1);
    expect(frozen.err).toContain("isn't open");
    const foreign = h.cli(["draft", "add", "summary", "evil/repo#1"], "**Goal:** x");
    expect(foreign.code).toBe(1);
    expect(foreign.err).toContain("not one of the team's repos");

    expect(h.cli(["draft", "add", "day", today()], "## Done\n- x").code).toBe(0);
    appendFileSync(h.draft, "\n<!-- houston:comment evil/repo#1 -->\nhello\n");
    const pub = h.cli(["publish"]);
    expect(pub.code).toBe(1);
    expect(pub.err).toContain("comment evil/repo#1");
    expect(existsSync(h.draft)).toBe(true);
    expect(existsSync(h.dayLog)).toBe(false);
  }, 60_000);
});
