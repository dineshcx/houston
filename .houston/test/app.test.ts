// The local app's API: assembled cadence pages, saving the people's page, the CSRF and path
// guards, the board's columns and the draft. Runs `houston app` as a subprocess against a temp repo.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../src/cli.ts");
const tmp = mkdtempSync(join(tmpdir(), "houston-app-"));
const root = join(tmp, "repo");
const today = new Date().toISOString().slice(0, 10); // the person's timezone is UTC
const old = "2026-01-05";
let server: ReturnType<typeof Bun.spawn>;
let base = "";

const write = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
const git = (...args: string[]) => Bun.spawnSync(["git", "-C", root, ...args]).stdout.toString().trim();

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
    write(join(dir, "raj.md"), "## Done\n- reviewed\n");
  }
  write(join(root, ".houston-local/draft.md"), "<!-- houston:day 2026-11-13 -->\n## Done\n- x\n");
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "Test");
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "fixture");

  const fake = join(tmp, "github.json");
  writeFileSync(fake, JSON.stringify({
    login: "ana",
    issues: [
      issue(1, ["status:todo", "p1"], "<!-- houston:summary -->\n**Goal:** g\n<!-- /houston:summary -->\nrest"),
      issue(2, ["status:blocked"]),
      issue(3, []),
      issue(4, ["status:backlog"]),
    ],
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
  test("a period is assembled from _page.md and each person's file, with members who wrote nothing", async () => {
    const { status, body } = await get(`/api/page/web/daily/${today}`);
    expect(status).toBe(200);
    expect(body.frozen).toBe(false);
    expect(body.page).toContain("## Notes");
    expect(body.prev).toBe(old);
    const [ana, raj, kim] = body.people;
    expect(ana).toMatchObject({ user: "ana", body: "## Done\n- shipped retries", notReviewed: true, sourceProblem: true });
    expect(ana.footer).toStartWith("run 09:00");
    expect(raj).toMatchObject({ user: "raj", footer: null });
    expect(kim).toEqual({ user: "kim", missing: true });
  });

  test("a past period is frozen and can't be saved", async () => {
    expect((await get(`/api/page/web/daily/${old}`)).body.frozen).toBe(true);
    expect((await send("PUT", `/api/page/web/daily/${old}`, { text: "x" })).status).toBe(409);
  });

  test("saving _page.md writes the file and commits only it", async () => {
    const { status, body } = await send("PUT", `/api/page/web/daily/${today}`, { text: "# Daily\n\n## Decisions\n- ship it" });
    expect(status).toBe(200);
    expect(body.committed).toBe(true);
    expect(readFileSync(join(root, "projects/web/daily", today, "_page.md"), "utf8")).toBe("# Daily\n\n## Decisions\n- ship it\n");
    expect(git("log", "-1", "--format=%s")).toBe(`houston: page web/daily/${today}`);
    expect(git("show", "--name-only", "--format=", "HEAD")).toBe(`projects/web/daily/${today}/_page.md`);
  });

  test("periods that aren't dates, or would leave the folder, are refused", async () => {
    expect((await get(`/api/page/web/daily/${encodeURIComponent("../../../etc")}`)).status).toBe(400);
    expect((await get("/api/page/web/daily/2026-02-30")).status).toBe(400);
    expect((await get(`/api/page/${encodeURIComponent("..")}/daily`)).status).toBe(404);
    expect((await get("/api/page/web/nope")).status).toBe(404);
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
    const cols = Object.fromEntries(body.columns.map((c: any) => [c.name, c.cards.map((i: any) => i.number)]));
    expect(cols).toEqual({ Todo: [1], Stuck: [2], "No status": [3, 4] });
    const first = body.columns[0].cards[0];
    expect(first).toMatchObject({ ref: "acme/web#1", priority: "p1", hasSummary: true, assignees: ["ana"] });
  });

  test("an issue shows its summary separately from the rest of the body", async () => {
    const { body } = await get("/api/issues/acme/web/1");
    expect(body).toMatchObject({ summary: "**Goal:** g", body: "rest" });
    expect((await get("/api/issues/other/repo/1")).status).toBe(400);
  });
});

describe("draft", () => {
  test("reads and saves the draft", async () => {
    expect((await get("/api/draft")).body).toMatchObject({ exists: true, text: expect.stringContaining("## Done") });
    const saved = await send("PUT", "/api/draft", { text: "edited\n" });
    expect(saved.status).toBe(200);
    expect(readFileSync(join(root, ".houston-local/draft.md"), "utf8")).toBe("edited\n");
  });
});
