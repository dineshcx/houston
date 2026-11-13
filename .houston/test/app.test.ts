// The local app's API: Today, assembled cadence pages (footers parsed, Blocked lines, reasons for
// missing updates), writing the Notes and syncing them separately (refused when stale), the CSRF and
// path guards, the board's columns, issue chips, intake review, the draft (structured, edited one
// section at a time), Setup as data, and the vendored editor bundle. Runs `houston app` as a
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
team: { name: Web team, leads: [ana], members: [ana, raj, kim, lee] }
projects:
  web: { name: Web, repos: [acme/web], cadences: [daily] }
status:
  columns: [{ label: todo, name: Todo }, { label: blocked, name: Stuck }]
`);
  write(join(root, "houston.local.yml"), "user: ana\ntimezone: UTC\nrepos: {}\n");
  write(join(root, "cadences/daily.md"), "---\ntitle: Daily\nschedule: daily 10:00\nperiod: day\n---\n## Done\n");
  for (const period of [old, today]) {
    const dir = join(root, "projects/web/daily", period);
    write(join(dir, "_page.md"), "# Daily\n\n## Notes\n");
    write(join(dir, "ana.md"), "## Done\n- shipped retries\n\n## Blocked\n- acme/web#2 waiting on design (@raj)\n- [ ] staging is down\n\n_run 09:00 · sources: github ok, sessions failed: no access · not reviewed_\n");
    write(join(dir, "raj.md"), "## Done\n- reviewed\n\n## Blocked\n- Nothing.\n\n_run 10:00 · sources: github ok_\n");
    write(join(dir, "kim.md"), "## Done\n- no footer\n");
  }
  const draft =
    "<!-- houston draft · window … -->\n\n<!-- houston:page web/daily/2026-11-13 -->\n## Done\n- x\n\n\n<!-- houston:day 2026-11-13 -->\n- worked\n  - nested, with trailing spaces  \n\n\n<!-- houston:labels acme/web#1 -->\nstatus:blocked\n\n\n<!-- houston:summary acme/web#1 -->\n**Goal:** g2\n";
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

describe("today", () => {
  test("one call answers the home screen: my draft, today's pages with counts, and the checklist", async () => {
    const { status, body } = await get("/api/today");
    expect(status).toBe(200);
    expect(body.draft).toMatchObject({ summary: "Update for Web · Daily, day log, 1 issue summary, 1 label change", sections: 4, deadlineAt: "2026-11-13T09:45:00.000Z" });
    const [page] = body.pages;
    expect(page).toMatchObject({ project: "web", cadence: "daily", period: today, exists: true, meetsToday: true });
    expect(page.counts).toEqual({ members: 4, published: 3, clean: 2, notReviewed: 1, failedSource: 1, missing: 1, blocked: 2 });
    expect(page.updates.find((u: any) => u.user === "lee")).toEqual({ user: "lee", state: "missing", reason: "Never ran on any laptop" });
    expect(Object.fromEntries(body.checklist.map((c: any) => [c.id, c.done]))).toMatchObject({ valid: true, schedule: false, "first-run": false, teammates: true });
    expect(body.attention.people.map((p: any) => p.user)).toEqual(["ana", "lee"]);
  });
});

describe("cadence pages", () => {
  test("a period is assembled from the Notes and each person's Update, with members who wrote nothing", async () => {
    const { status, body } = await get(`/api/page/web/daily/${today}`);
    expect(status).toBe(200);
    expect(body.frozen).toBe(false);
    expect(body.notes).toContain("## Notes");
    expect(body.prev).toBe(old);
    const [ana, raj, kim, lee, extra] = body.updates;
    expect(ana).toMatchObject({ user: "ana", me: true, lead: true, missing: false, body: expect.stringContaining("## Done\n- shipped retries\n\n## Blocked") });
    expect(ana.footer).toEqual({ time: "09:00", sources: { github: "ok", sessions: "failed:" }, notReviewed: true, problem: true, failed: ["sessions"] });
    // The old parser kept the closing "_" on the last source, so this footer showed a false warning.
    expect(raj.footer).toEqual({ time: "10:00", sources: { github: "ok" }, notReviewed: false, problem: false, failed: [] });
    expect(kim).toMatchObject({ body: "## Done\n- no footer", footer: null });
    expect(lee).toMatchObject({ user: "lee", missing: true, reason: { kind: "never-ran", text: "Never ran on any laptop" } });
    expect(extra).toBeUndefined();
  });

  test("Blocked lines are pulled out per person, leaving out 'nothing'", async () => {
    const { body } = await get(`/api/page/web/daily/${today}`);
    expect(body.updates[0].blocked).toEqual(["acme/web#2 waiting on design (@raj)", "staging is down"]);
    expect(body.updates[1].blocked).toEqual([]);
    expect(body.blocked).toEqual([
      { user: "ana", text: "acme/web#2 waiting on design (@raj)", refs: ["acme/web#2"] },
      { user: "ana", text: "staging is down", refs: [] },
    ]);
    expect(body.counts).toMatchObject({ published: 3, missing: 1, blocked: 2 });
  });

  test("the periods list says which periods have notes and updates, newest first", async () => {
    const { body } = await get(`/api/page/web/daily/${old}`);
    expect(body.periods.map((p: any) => [p.period, p.current, p.frozen, p.updates])).toEqual([
      [today, true, false, 3],
      [old, false, true, 3],
    ]);
    expect(body.updates.find((u: any) => u.user === "lee").reason.kind).toBe("past-period");
  });

  test("a past period is frozen and can't be saved", async () => {
    const { body } = await get(`/api/page/web/daily/${old}`);
    expect(body.frozen).toBe(true);
    expect((await send("PUT", `/api/page/web/daily/${old}`, { text: "x", hash: body.notesHash })).status).toBe(409);
  });

  test("writing the Notes only writes the file; sync commits only it and pushes", async () => {
    const { body: page } = await get(`/api/page/web/daily/${today}`);
    const before = git("rev-parse", "HEAD");
    const { status, body } = await send("PUT", `/api/page/web/daily/${today}`, { text: "# Daily\n\n## Decisions\n- ship it", hash: page.notesHash });
    expect(status).toBe(200);
    expect(body).toMatchObject({ unpushed: true });
    expect(readFileSync(join(root, "projects/web/daily", today, "_page.md"), "utf8")).toBe("# Daily\n\n## Decisions\n- ship it\n");
    expect(git("rev-parse", "HEAD")).toBe(before);
    expect((await get(`/api/page/web/daily/${today}`)).body).toMatchObject({ notesUnpushed: true, notesHash: body.hash });

    const synced = await send("POST", `/api/page/web/daily/${today}/sync`, {});
    expect(synced.status).toBe(200);
    expect(synced.body).toMatchObject({ conflict: false, committed: true, pushed: true, hash: body.hash });
    expect(git("log", "-1", "--format=%s")).toBe(`houston: notes web/daily/${today}`);
    expect(git("show", "--name-only", "--format=", "HEAD")).toBe(`projects/web/daily/${today}/_page.md`);
    expect(git("rev-parse", "origin/main")).toBe(git("rev-parse", "HEAD"));
    expect((await get(`/api/page/web/daily/${today}`)).body.notesUnpushed).toBe(false);
  });

  test("a write from a stale copy is refused instead of overwriting a teammate's edit", async () => {
    const { body: page } = await get(`/api/page/web/daily/${today}`);
    write(join(root, "projects/web/daily", today, "_page.md"), "# Daily\n\nraj's edit\n");
    git("commit", "-qam", "raj edits the notes");
    const r = await send("PUT", `/api/page/web/daily/${today}`, { text: "mine", hash: page.notesHash });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("These notes changed since you opened them");
    expect(r.body.theirs).toBe("# Daily\n\nraj's edit\n");
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

// The frontend (app/public, minus the vendored editor) is plain ES modules served under a strict CSP:
// no inline scripts, no style="" attributes, no external images. These catch a slip before a browser does.
describe("frontend files", () => {
  const pub = join(import.meta.dir, "../app/public");
  const files = [...new Bun.Glob("**/*.{js,html}").scanSync(pub)].filter((f) => !f.startsWith("vendor/"));

  test("index.html loads only same-origin scripts, the theme script first", async () => {
    const r = await fetch(`${base}/`);
    expect(r.headers.get("content-security-policy")).toContain("default-src 'self'");
    const page = await r.text();
    expect(page).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/); // every <script> has a src
    expect(page.indexOf("/theme.js")).toBeLessThan(page.indexOf("/style.css"));
  });

  test("no file relies on what the CSP blocks", () => {
    for (const f of files) {
      const code = readFileSync(join(pub, f), "utf8").split("\n").filter((l) => !/^\s*(\/\/|<!--)/.test(l)).join("\n");
      expect({ f, inlineStyle: /\sstyle=["'$]/.test(code) }).toEqual({ f, inlineStyle: false });
      expect({ f, remoteImage: /<img[^>]+src=["']https?:/.test(code) }).toEqual({ f, remoteImage: false });
    }
  });

  test("every module the app imports exists and is served", async () => {
    for (const f of files.filter((x) => x.endsWith(".js"))) {
      const code = readFileSync(join(pub, f), "utf8");
      for (const m of code.matchAll(/(?:import\(|from )\s*["'](\.{1,2}\/[^"']+|\/[^"']+)["']/g)) {
        const url = m[1].startsWith("/") ? m[1] : new URL(m[1], `http://x/${f}`).pathname;
        const r = await fetch(base + url);
        expect({ f, url, status: r.status }).toEqual({ f, url, status: 200 });
      }
    }
  });
});

describe("board", () => {
  test("issues are grouped by the team's columns, with a No status column for the rest", async () => {
    const { body } = await get("/api/board");
    const cols = Object.fromEntries(body.columns.map((c: any) => [c.name, c.cards.map((i: any) => i.ref)]));
    expect(cols).toEqual({ Todo: ["acme/web#1"], Stuck: ["acme/web#2"], "No status": ["acme/web#3", "acme/web#4"] });
    expect(body.columns[0].cards[0]).toMatchObject({ ref: "acme/web#1", priority: "p1", hasSummary: true, assignees: ["ana"], column: "todo" });
    expect(Date.parse(body.fetchedAt)).toBeGreaterThan(0);
    expect(body.columns[2].cards[1]).toMatchObject({ status: "backlog", column: null });
  });

  test("an issue shows its summary separately from the rest of the body, and when it was fetched", async () => {
    const { body } = await get("/api/issues/acme/web/1");
    expect(body).toMatchObject({ summary: "**Goal:** g", body: "rest", fetchedAt: expect.any(String) });
    expect((await get("/api/issues/other/repo/1")).status).toBe(400);
  });
});

describe("issue chips", () => {
  test("a lookup answers from the board cache, fetches what it lacks, and refuses other repos", async () => {
    const { body } = await get(`/api/issues?refs=${encodeURIComponent("acme/web#1,acme/web#2,other/repo#1,acme/web#99")}`);
    expect(body.issues["acme/web#1"]).toMatchObject({ title: "Issue 1", state: "open", status: "todo", statusName: "Todo", assignees: ["ana"], ident: "web#1", hasSummary: true });
    expect(body.issues["acme/web#2"]).toMatchObject({ status: "blocked", statusName: "Stuck" });
    expect(body.issues["other/repo#1"]).toBeNull();
    expect(body.issues["acme/web#99"]).toBeNull();
    expect(body.errors["acme/web#99"]).toContain("not an issue you can see");
    expect(Date.parse(body.fetchedAt)).toBeGreaterThan(0);
  });
});

describe("setup", () => {
  test("the team's setup comes back as data, with rules as sentences and the validation result", async () => {
    const { body } = await get("/api/setup");
    expect(body.team).toEqual({ name: "Web team", leads: ["ana"], members: ["ana", "raj", "kim", "lee"] });
    expect(body.projects).toEqual([
      {
        id: "web",
        name: "Web",
        mine: true,
        repos: [{ repo: "acme/web", about: null, linkedAt: null }],
        cadences: [{ name: "daily", title: "Daily", schedule: { days: [0, 1, 2, 3, 4, 5, 6], time: "10:00" }, scheduleText: "every day 10:00", period: "day", periodName: "Daily", periodText: "one page per day", writers: ["runs", "people"] }],
      },
    ]);
    expect(body.rules.sentences).toContain("Houston never closes issues; people do.");
    expect(body.validation).toEqual({ ok: true, problems: [] });
    expect(body.statuses).toEqual([{ label: "todo", name: "Todo" }, { label: "blocked", name: "Stuck" }]);
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
  test("the summary names up to two pages, then counts them", async () => {
    const { summarize } = await import("../app/api/draft");
    const ctx = { team: { projects: { a: { name: "A" }, b: { name: "B" } } }, cadences: { daily: { title: "Daily" } } } as never;
    const pages = (...t: string[]) => t.map((target) => ({ kind: "page", target })) as never;
    expect(summarize(ctx, pages("a/daily", "b/daily"))).toBe("Update for A · Daily and B · Daily");
    expect(summarize(ctx, pages("a/daily", "b/daily", "a/weekly"))).toBe("Updates for 3 pages");
  });
  test("sections come back structured: where each goes, label changes as from → to", async () => {
    const { body } = await get("/api/draft");
    expect(body).toMatchObject({ exists: true, edited: false, held: false, deadline: "2026-11-13 09:45", deadlineAt: "2026-11-13T09:45:00.000Z", text: expect.stringContaining("## Done") });
    expect(body.sections.map((s: any) => [s.kind, s.target, s.label])).toEqual([
      ["page", "web/daily/2026-11-13", "Your update · Web · Daily · Fri 13 Nov"],
      ["day", "2026-11-13", "Your day log · Fri 13 Nov"],
      ["labels", "acme/web#1", "Issue changes · web#1 Issue 1"],
      ["summary", "acme/web#1", "Living summary · web#1 Issue 1"],
    ]);
    expect(body.sections[2].changes).toEqual([{ field: "status", from: "todo", to: "blocked", fromName: "Todo", toName: "Stuck" }]);
    expect(body.sections[3].currentSummary).toBe("**Goal:** g");
  });

  test("editing one section rewrites only its lines; every marker and other section stays byte for byte", async () => {
    const file = join(root, ".houston-local/draft.md");
    const before = readFileSync(file, "utf8");
    const { body: d } = await get("/api/draft");
    const r = await send("PUT", "/api/draft/sections/1", { body: "- rewritten\n", hash: d.hash, kind: "day", target: "2026-11-13" });
    expect(r.status).toBe(200);
    expect(r.body.edited).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(before.replace("- worked\n  - nested, with trailing spaces  \n", "- rewritten\n"));
    // The copy the person opened is now stale.
    expect((await send("PUT", "/api/draft/sections/0", { body: "x", hash: d.hash })).status).toBe(409);
    // Each section is checked like `houston draft add` would.
    expect((await send("PUT", "/api/draft/sections/2", { body: "status:nope" })).body.error).toContain("isn't a label Houston manages");
    const removed = await send("DELETE", "/api/draft/sections/3", { hash: r.body.hash });
    expect(removed.body.sections.length).toBe(3);
    expect(readFileSync(file, "utf8")).toBe(before.replace("- worked\n  - nested, with trailing spaces  \n", "- rewritten\n").replace("\n\n\n<!-- houston:summary acme/web#1 -->\n**Goal:** g2\n", "\n"));
  });

  test("the raw file can still be saved whole", async () => {
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

// The Notes editor is a committed bundle (app/public/vendor/editor.js) built from app/editor/editor.ts
// with the TipTap devDependencies. These need `bun install`; without it they are skipped.
const haveTiptap = existsSync(join(import.meta.dir, "../node_modules/@tiptap/core/package.json"));
if (!haveTiptap) console.warn("Skipping the editor bundle tests: the TipTap devDependencies aren't installed. Run `bun install` in .houston.");

// Bundles are only byte-identical with the same Bun, pinned in .houston/.bun-version (CI uses it too).
const pinnedBun = readFileSync(join(import.meta.dir, "../.bun-version"), "utf8").trim();
if (haveTiptap && Bun.version !== pinnedBun) console.warn(`Skipping the editor rebuild check: it needs Bun ${pinnedBun} (this is ${Bun.version}).`);

describe("editor bundle", () => {
  test.skipIf(!haveTiptap || Bun.version !== pinnedBun)("rebuilding it from source gives the committed file, byte for byte", async () => {
    const { buildEditor, sha256 } = await import("../app/editor/build");
    const committed = readFileSync(join(import.meta.dir, "../app/public/vendor/editor.sha256"), "utf8").split(" ")[0];
    expect(sha256(readFileSync(join(import.meta.dir, "../app/public/vendor/editor.js"), "utf8"))).toBe(committed);
    expect(sha256(await buildEditor())).toBe(committed);
  }, 60_000);

  test.skipIf(!haveTiptap)("what Houston writes survives markdown → editor → markdown unchanged", async () => {
    const { roundTrip } = await import("../app/editor/editor");
    const page = `# Daily standup, 2026-11-13

## Agenda

- Checkout retries (acme/web#12)
- Release plan for acme/app#3
  - nested under it

## Notes

Ana walked through **the payment** flow and *retry* rules. See [the doc](https://example.com/doc).

1. first
2. second

### Smaller heading

## Decisions

- Ship retries behind a flag; acme/api#7 tracks it.

## Action items

- [ ] @raj fix acme/web#14 before Friday
- [x] @mei update the runbook
`;
    expect(roundTrip(page)).toBe(page.trimEnd());
    const empty = "# Daily standup, 2026-11-13\n\n## Agenda\n\n## Notes\n\n## Decisions\n\n## Action items\n";
    expect(roundTrip(empty)).toBe(empty.trimEnd());
  });
});
