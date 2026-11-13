// The local app's API: assembled cadence pages (footers parsed), saving the Notes (refused when stale),
// the CSRF and path guards, the board's columns, intake review and the draft. Runs `houston app` as a
// subprocess against a temp repo whose origin is a local bare repo named like a GitHub one.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../src/cli.ts");
const tmp = mkdtempSync(join(tmpdir(), "houston-app-"));
const root = join(tmp, "repo");
const today = new Date().toISOString().slice(0, 10); // the person's timezone is UTC
const old = "2026-01-05";
const origin = join(tmp, "github.com/acme/houston.git"); // houstonRepo() reads acme/houston from the path
let server: ReturnType<typeof Bun.spawn>;
let base = "";

const write = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
const git = (...args: string[]) => Bun.spawnSync(["git", "-C", root, "-c", "commit.gpgsign=false", ...args]).stdout.toString().trim();
const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 16); // state.ts's hash

const issue = (number: number, labels: string[], body = "") => ({
  repo: "acme/web", number, title: `Issue ${number}`, state: "open", body, labels, assignees: ["ana"], url: `https://github.com/acme/web/issues/${number}`, updatedAt: "2026-11-13T00:00:00Z",
});

beforeAll(async () => {
  write(join(root, "houston.yml"), `houston: 1
core: 0.1.0
team: { name: Web team, leads: [ana], members: [ana, raj, kim] }
projects:
  web: { name: Web, repos: [acme/web], cadences: [daily] }
status:
  columns: [{ label: todo, name: Todo }, { label: blocked, name: Stuck }]
`);
  write(join(root, "houston.local.yml"), "user: ana\ntimezone: UTC\nrepos: {}\n");
  write(join(root, "cadences/daily.md"), "---\ntitle: Daily\nschedule: Mon-Fri 10:00\nperiod: day\n---\n## Done\n");
  for (const period of [old, today]) {
    const dir = join(root, "projects/web/daily", period);
    write(join(dir, "_page.md"), "# Daily\n\n## Notes\n");
    write(join(dir, "ana.md"), "## Done\n- shipped retries\n\n_run 09:00 · sources: github ok, sessions failed: no access · not reviewed_\n");
    write(join(dir, "raj.md"), "## Done\n- reviewed\n\n_run 10:00 · sources: github ok_\n");
    write(join(dir, "kim.md"), "## Done\n- no footer\n");
  }
  const draft = "<!-- houston:day 2026-11-13 -->\n## Done\n- x\n";
  write(join(root, ".houston-local/draft.md"), draft);
  write(join(root, ".houston-local/state.json"), JSON.stringify({ draft: { created: "2026-11-13T06:00:00Z", window_start: "2026-11-13T03:00:00Z", window_end: "2026-11-13T06:00:00Z", deadline: "2026-11-13T09:45:00Z", agent_hash: sha(draft), sources: {}, inbox: [] } }));
  // A repo-root bunfig.toml must never preload code into the CLI the app runs.
  write(join(root, "bunfig.toml"), 'preload = ["./evil.ts"]\n');
  write(join(root, "evil.ts"), 'require("node:fs").writeFileSync(require("node:path").join(import.meta.dir, "preloaded"), "x");\n');
  write(join(root, ".gitignore"), ".houston-local/\nhouston.local.yml\n");
  Bun.spawnSync(["git", "init", "-q", "--bare", "-b", "main", origin]);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "Test");
  git("add", ".");
  git("commit", "-qm", "fixture");
  git("remote", "add", "origin", origin);
  git("push", "-q", "-u", "origin", "main");
  git("remote", "set-head", "origin", "main");
  // An intake PR whose proposal names a project that doesn't exist.
  git("switch", "-q", "-c", "intake/standup");
  write(join(root, "proposals/2026-11-13-standup.yml"), "title: Standup\nproject: nope\nsource: standup\nchanges: []\nskipped: []\n");
  write(join(root, "meetings/2026-11-13-standup.md"), "# Standup\n");
  git("add", ".");
  git("commit", "-qm", "intake");
  git("push", "-q", "origin", "intake/standup");
  git("switch", "-q", "main");

  const fake = join(tmp, "github.json");
  writeFileSync(fake, JSON.stringify({
    login: "ana",
    issues: [
      issue(1, ["status:todo", "p1"], "<!-- houston:summary -->\n**Goal:** g\n<!-- /houston:summary -->\nrest"),
      issue(2, ["status:blocked"]),
      issue(3, []),
      issue(4, ["status:backlog"]),
    ],
    pulls: [{ repo: "acme/houston", number: 7, title: "Standup", body: "", state: "open", url: "https://github.com/acme/houston/pull/7", branch: "intake/standup", author: "ana", labels: ["houston:intake"], updatedAt: "2026-11-13T00:00:00Z" }],
  }));

  mkdirSync(join(tmp, "home"));
  server = Bun.spawn(["bun", CLI, "app", "--port", "0", "--no-open"], {
    env: { ...process.env, HOUSTON_ROOT: root, HOUSTON_FAKE_GITHUB: fake, HOME: join(tmp, "home") },
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = (server.stdout as ReadableStream<Uint8Array>).getReader();
  let out = "";
  while (!/http:\/\/127\.0\.0\.1:\d+/.test(out)) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`houston app exited: ${out}`);
    out += new TextDecoder().decode(value);
  }
  base = /http:\/\/127\.0\.0\.1:\d+/.exec(out)![0];
});

afterAll(() => server?.kill());

const get = (path: string) => fetch(base + path).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
const send = (method: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));

describe("cadence pages", () => {
  test("a period is assembled from the Notes and each person's Update, with members who wrote nothing", async () => {
    const { status, body } = await get(`/api/page/web/daily/${today}`);
    expect(status).toBe(200);
    expect(body.frozen).toBe(false);
    expect(body.notes).toContain("## Notes");
    expect(body.prev).toBe(old);
    const [ana, raj, kim, bo] = body.updates;
    expect(ana).toMatchObject({ user: "ana", body: "## Done\n- shipped retries" });
    expect(ana.footer).toEqual({ time: "09:00", sources: { github: "ok", sessions: "failed:" }, notReviewed: true, problem: true });
    // The old parser kept the closing "_" on the last source, so this footer showed a false warning.
    expect(raj.footer).toEqual({ time: "10:00", sources: { github: "ok" }, notReviewed: false, problem: false });
    expect(kim).toMatchObject({ body: "## Done\n- no footer", footer: null });
    expect(bo).toBeUndefined();
  });

  test("a past period is frozen and can't be saved", async () => {
    const { body } = await get(`/api/page/web/daily/${old}`);
    expect(body.frozen).toBe(true);
    expect((await send("PUT", `/api/page/web/daily/${old}`, { text: "x", hash: body.notesHash })).status).toBe(409);
  });

  test("saving the Notes writes _page.md and commits only it", async () => {
    const { body: page } = await get(`/api/page/web/daily/${today}`);
    const { status, body } = await send("PUT", `/api/page/web/daily/${today}`, { text: "# Daily\n\n## Decisions\n- ship it", hash: page.notesHash });
    expect(status).toBe(200);
    expect(body).toMatchObject({ committed: true, pushed: true });
    expect(readFileSync(join(root, "projects/web/daily", today, "_page.md"), "utf8")).toBe("# Daily\n\n## Decisions\n- ship it\n");
    expect(git("log", "-1", "--format=%s")).toBe(`houston: notes web/daily/${today}`);
    expect(git("show", "--name-only", "--format=", "HEAD")).toBe(`projects/web/daily/${today}/_page.md`);
  });

  test("a save from a stale copy is refused instead of overwriting a teammate's edit", async () => {
    const { body: page } = await get(`/api/page/web/daily/${today}`);
    write(join(root, "projects/web/daily", today, "_page.md"), "# Daily\n\nraj's edit\n");
    git("commit", "-qam", "raj edits the notes");
    const r = await send("PUT", `/api/page/web/daily/${today}`, { text: "mine", hash: page.notesHash });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("Someone else changed these notes");
    expect(readFileSync(join(root, "projects/web/daily", today, "_page.md"), "utf8")).toBe("# Daily\n\nraj's edit\n");
  });

  test("periods that aren't dates, or would leave the folder, are refused", async () => {
    expect((await get(`/api/page/web/daily/${encodeURIComponent("../../../etc")}`)).status).toBe(400);
    expect((await get("/api/page/web/daily/2026-02-30")).status).toBe(400);
    expect((await get(`/api/page/${encodeURIComponent("..")}/daily`)).status).toBe(404);
    expect((await get("/api/page/web/nope")).status).toBe(400);
  });
});

describe("guards", () => {
  test("a write from another origin is refused", async () => {
    const r = await send("POST", "/api/draft/hold", {}, { Origin: "http://evil.example" });
    expect(r.status).toBe(403);
    expect(r.body.error).toContain("own pages");
  });

  test("a write that isn't JSON is refused", async () => {
    const r = await fetch(`${base}/api/draft`, { method: "PUT", headers: { "Content-Type": "text/plain" }, body: "x" });
    expect(r.status).toBe(403);
  });
});

describe("board", () => {
  test("issues are grouped by the team's columns, with a No status column for the rest", async () => {
    const { body } = await get("/api/board");
    const cols = Object.fromEntries(body.columns.map((c: any) => [c.name, c.cards.map((i: any) => i.ref)]));
    expect(cols).toEqual({ Todo: ["acme/web#1"], Stuck: ["acme/web#2"], "No status": ["acme/web#3", "acme/web#4"] });
    expect(body.columns[0].cards[0]).toMatchObject({ ref: "acme/web#1", priority: "p1", hasSummary: true, assignees: ["ana"], column: "todo" });
    expect(body.columns[2].cards[1]).toMatchObject({ status: "backlog", column: null });
  });

  test("an issue shows its summary separately from the rest of the body", async () => {
    const { body } = await get("/api/issues/acme/web/1");
    expect(body).toMatchObject({ summary: "**Goal:** g", body: "rest" });
    expect((await get("/api/issues/other/repo/1")).status).toBe(400);
  });
});

describe("review", () => {
  test("an intake PR whose proposal apply would refuse shows why, not its changes", async () => {
    const { status, body } = await get("/api/review");
    expect(status).toBe(200);
    expect(body.repo).toBe("acme/houston");
    const [pr] = body.prs;
    expect(pr).toMatchObject({ number: 7, proposalPath: "proposals/2026-11-13-standup.yml", notes: [{ path: "meetings/2026-11-13-standup.md", text: "# Standup" }] });
    expect(pr.refused).toContain('"nope" is not a project');
    expect(pr.changes).toBeUndefined();
  });
});

describe("draft", () => {
  test("shows the draft's status and marks it edited once the person saves a change", async () => {
    expect((await get("/api/draft")).body).toMatchObject({ exists: true, edited: false, held: false, deadline: "2026-11-13 09:45", text: expect.stringContaining("## Done") });
    const saved = await send("PUT", "/api/draft", { text: "edited\n" });
    expect(saved.status).toBe(200);
    expect(saved.body.edited).toBe(true);
    expect(readFileSync(join(root, ".houston-local/draft.md"), "utf8")).toBe("edited\n");
  });

  test("hold runs the CLI without loading the repo's bunfig.toml", async () => {
    const r = await send("POST", "/api/draft/hold", {});
    expect(r.status).toBe(200);
    expect(r.body.held).toBe(true);
    expect(existsSync(join(root, "preloaded"))).toBe(false);
  });
});
