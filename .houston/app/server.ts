// The local app's server: a JSON API plus three static files, on 127.0.0.1 only.
// Reads use the shared core directly. Run-loop writes (publish, hold/release/discard, labels, new
// pages) go through the houston CLI, so the run lock and the team's rules live in one place; saving
// the people-written Notes goes through the same writeInRepo + commitAndPush as every other write.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addDays, cadenceOf, formatAt, isDate, nextPeriod, periodDir, periodOf, zoned, type Cadence } from "../src/lib/cadence";
import { loadContext, PRIORITIES, STATUSES, teamRepos, type Context, type Team } from "../src/lib/config";
import { draftStatus } from "../src/lib/draft";
import { github, refText, type Issue, type IssueRef } from "../src/lib/github";
import { assertTeamRepo, readSummary, withoutSummary } from "../src/lib/issues";
import { dayLogFile, myProjects, pageFile, parseFooter, stripFooter, writeInRepo } from "../src/lib/pages";
import { paths } from "../src/lib/paths";
import { describeChange, parseProposal } from "../src/lib/proposals";
import { commitAndPush, defaultBranch, git, houstonRepo, pull } from "../src/lib/repo";
import { hash, readState } from "../src/lib/state";
import { HoustonError, parseDuration, sh } from "../src/lib/util";

const PUBLIC = join(import.meta.dir, "public");
const STATIC: Record<string, string> = { "/": "index.html", "/index.html": "index.html", "/app.js": "app.js", "/style.css": "style.css" };
const GITHUB_TTL_MS = 60_000;

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---------- what every request needs ----------

type Ctx = Context & { today: string };

/** Re-read on every request so edits to houston.yml or cadences/ show without a restart. */
function context(): Ctx {
  const ctx = loadContext();
  return { ...ctx, today: zoned(new Date(), ctx.local.timezone).date };
}

/**
 * Runs the houston CLI: the trusted copy when there is one, else this core. `--config` names
 * Houston's own empty bunfig.toml, so a bunfig.toml at the repo root can't preload code.
 */
function houston(args: string[]): { ok: boolean; output: string } {
  const cli = existsSync(paths.bin) ? [paths.bin] : [process.execPath, `--config=${join(paths.core, "bunfig.toml")}`, join(paths.core, "src/cli.ts")];
  const r = sh([...cli, ...args], { cwd: paths.root });
  return { ok: r.ok, output: [r.stdout, r.stderr].filter(Boolean).join("\n") };
}

function mustHouston(args: string[]): string {
  const r = houston(args);
  if (!r.ok) throw new HttpError(422, r.output || `houston ${args[0]} failed.`);
  return r.output;
}

/** GitHub reads are slow; screens share one copy for a minute unless the person asks to refresh. */
const cache = new Map<string, { at: number; data: any }>();
function cached<T>(key: string, refresh: boolean, load: () => T): { at: number; data: T } {
  const hit = cache.get(key);
  if (!refresh && hit && Date.now() - hit.at < GITHUB_TTL_MS) return hit;
  const fresh = { at: Date.now(), data: load() };
  cache.set(key, fresh);
  return fresh;
}

function refFrom(ctx: Ctx, owner: string, repo: string, number: string): IssueRef {
  if (!/^\d+$/.test(number)) throw new HttpError(400, `"${number}" is not an issue number.`);
  const ref = { repo: `${owner}/${repo}`, number: Number(number) };
  assertTeamRepo(ctx.team, ref.repo);
  return ref;
}

// ---------- cadence pages: the people-written Notes and each person's Update ----------

function checkPeriod(c: Cadence, period: string) {
  if (!isDate(period) || periodOf(c, period) !== period) throw new HttpError(400, `"${period}" is not the first day of a ${c.title} period.`);
}

/** A run footer for the browser: when, each source's health, "not reviewed", and whether any source failed. */
function footerOf(text: string) {
  const f = parseFooter(text.trimEnd().split("\n").at(-1) ?? "");
  return f ? { ...f, problem: Object.values(f.sources).some((h) => h !== "ok") } : null;
}

function periodsOf(project: string, cadence: string): string[] {
  const dir = join(paths.projects, project, cadence);
  return existsSync(dir) ? readdirSync(dir).filter(isDate).sort() : [];
}

function readPage(ctx: Ctx, project: string, cadence: string, wanted?: string) {
  const c = cadenceOf(ctx.team, ctx.cadences, project, cadence);
  const current = periodOf(c, ctx.today);
  const period = wanted ?? current;
  checkPeriod(c, period);
  const dir = join(paths.root, periodDir(project, cadence, period));
  const exists = existsSync(dir);
  const writers = exists ? readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "_page.md").map((f) => f.slice(0, -3)) : [];
  const updates = [...new Set([...ctx.team.team.members, ...writers])].map((user) => {
    if (!writers.includes(user)) return { user, missing: true };
    const text = readFileSync(pageFile(`${project}/${cadence}/${period}`, user), "utf8");
    return { user, body: stripFooter(text), footer: footerOf(text) };
  });
  const notesFile = join(dir, "_page.md");
  const notes = existsSync(notesFile) ? readFileSync(notesFile, "utf8") : null;
  const periods = periodsOf(project, cadence);
  return {
    project,
    cadence: { name: c.name, title: c.title, period: c.period },
    period,
    current,
    frozen: ctx.today >= nextPeriod(c, period),
    exists,
    notes,
    /** Sent back on save, so a save can't overwrite a teammate's edit made since this was loaded. */
    notesHash: hash(notes ?? ""),
    prev: periods.filter((p) => p < period).at(-1) ?? null,
    next: periods.find((p) => p > period) ?? null,
    updates: exists ? updates : [],
  };
}

function saveNotes(ctx: Ctx, project: string, cadence: string, period: string, body: { text?: unknown; hash?: unknown }) {
  if (typeof body.text !== "string" || typeof body.hash !== "string") throw new HttpError(400, 'Send the notes as { text: "…", hash: "…" }.');
  checkPeriod(cadenceOf(ctx.team, ctx.cadences, project, cadence), period);
  const pulled = pull();
  if (!pulled.ok) throw new HttpError(409, `Couldn't bring in teammates' changes, so the notes weren't saved: ${pulled.note}`);
  const page = readPage(ctx, project, cadence, period);
  if (page.frozen) throw new HttpError(409, "This period is frozen because the next one has started. Past pages don't change.");
  if (!page.exists) throw new HttpError(409, "This period has no page yet. Create it first.");
  if (page.notesHash !== body.hash) throw new HttpError(409, "Someone else changed these notes since you opened them. Copy your text, reload, and apply it again.");
  const file = join(paths.root, periodDir(project, cadence, period), "_page.md");
  writeInRepo(file, body.text.endsWith("\n") ? body.text : `${body.text}\n`);
  const result = commitAndPush([file], `houston: notes ${project}/${cadence}/${period}`);
  return { ...result, notesHash: hash(readFileSync(file, "utf8")) };
}

// ---------- the board ----------

/** The team column an issue sits in: its status label, if the team shows that status; else null ("No status"). */
function columnOf(team: Team, labels: string[]): string | null {
  return team.status.columns.find((c) => labels.includes(`status:${c.label}`))?.label ?? null;
}

function toCard(team: Team, i: Issue, project: string) {
  return {
    ref: refText(i),
    project,
    title: i.title,
    url: i.url,
    assignees: i.assignees,
    status: i.labels.find((l) => l.startsWith("status:"))?.slice("status:".length) ?? null,
    column: columnOf(team, i.labels),
    priority: PRIORITIES.find((p) => i.labels.includes(p)) ?? null,
    hasSummary: readSummary(i.body) !== undefined,
  };
}

function board(ctx: Ctx, refresh: boolean) {
  const { at, data } = cached("board", refresh, () => {
    const issues: { issue: Issue; project: string }[] = [];
    const errors: string[] = [];
    for (const r of teamRepos(ctx.team)) {
      try {
        issues.push(...github().issues(r.repo).map((issue) => ({ issue, project: r.project })));
      } catch (e) {
        errors.push(`${r.repo}: ${(e as Error).message}`);
      }
    }
    return { issues, errors };
  });
  const cards = data.issues.map((i) => toCard(ctx.team, i.issue, i.project));
  return {
    fetchedAt: new Date(at).toISOString(),
    errors: data.errors,
    columns: [...ctx.team.status.columns, { label: null, name: "No status" }].map((c) => ({ ...c, cards: cards.filter((card) => card.column === c.label) })),
  };
}

function setStatus(ref: IssueRef, status: unknown) {
  if (!STATUSES.includes(status as (typeof STATUSES)[number])) throw new HttpError(400, `"${status}" is not a status. Use one of: ${STATUSES.join(", ")}.`);
  const output = mustHouston(["labels", refText(ref), `status:${status}`]);
  cache.delete("board");
  return { output };
}

function issue(ref: IssueRef) {
  const i = github().issue(ref);
  return { ref: refText(i), title: i.title, url: i.url, state: i.state, labels: i.labels, assignees: i.assignees, summary: readSummary(i.body) ?? null, body: withoutSummary(i.body) };
}

// ---------- intake review ----------

/** An intake PR's notes and proposal, read from its branch without checking it out, and checked like `houston apply` would. */
function intake(team: Team, base: string, branch: string) {
  if (!/^[\w][\w./-]*$/.test(branch) || branch.includes("..")) return { error: `The branch name "${branch}" looks unusual, so Houston didn't fetch it.` };
  const fetched = git(["fetch", "--quiet", "origin", branch]);
  if (!fetched.ok) return { error: `Couldn't fetch ${branch}: ${fetched.stderr}` };
  const names = git(["diff", "--name-only", `origin/${base}...origin/${branch}`]).stdout.split("\n").filter(Boolean);
  const show = (path: string) => git(["show", `origin/${branch}:${path}`]).stdout;
  const notes = names.filter((n) => n.endsWith(".md")).map((path) => ({ path, text: show(path) }));
  const proposalPath = names.find((n) => /^proposals\/.+\.ya?ml$/.test(n));
  if (!proposalPath) return { notes, proposalPath: null };
  try {
    const p = parseProposal(show(proposalPath), team, proposalPath);
    return { notes, proposalPath, changes: p.changes.map(describeChange), skipped: p.skipped };
  } catch (e) {
    if (!(e instanceof HoustonError)) throw e;
    return { notes, proposalPath, refused: e.message };
  }
}

function review(ctx: Ctx, refresh: boolean) {
  const repo = houstonRepo();
  if (!repo) return { repo: null, prs: [], fetchedAt: null };
  const { at, data } = cached("review", refresh, () => {
    const base = defaultBranch();
    return github()
      .pullRequests(repo, { label: "houston:intake" })
      .map((p) => ({ number: p.number, title: p.title, author: p.author, url: p.url, updatedAt: p.updatedAt, ...intake(ctx.team, base, p.branch) }));
  });
  return { repo, prs: data, fetchedAt: new Date(at).toISOString() };
}

function merge(number: string) {
  const repo = houstonRepo();
  if (!repo) throw new HttpError(409, "This Houston repo has no GitHub origin, so there is nothing to merge.");
  if (!/^\d+$/.test(number)) throw new HttpError(400, `"${number}" is not a pull request number.`);
  github().mergePullRequest(repo, Number(number));
  cache.delete("review");
  return { merged: true };
}

// ---------- my draft ----------

function readDraft(ctx: Ctx) {
  const d = draftStatus();
  if (!d) return { exists: false };
  const at = (t: string | Date) => formatAt(t, ctx.local.timezone);
  return {
    exists: true,
    text: d.text,
    edited: d.edited,
    held: d.held,
    deadline: d.deadline ? at(d.deadline) : null,
    created: at(d.draft.created),
    window: `${at(d.draft.window_start)} to ${at(d.draft.window_end)}`,
  };
}

function saveDraft(ctx: Ctx, text: unknown) {
  if (typeof text !== "string") throw new HttpError(400, 'Send the draft as { text: "…" }.');
  if (!draftStatus()) throw new HttpError(404, "There's no draft to save. Your next run makes one.");
  // A direct edit: draftStatus sees the changed hash and marks the draft edited.
  writeFileSync(paths.draft, text);
  return readDraft(ctx);
}

const DRAFT_ACTIONS: Record<string, string[]> = { publish: ["publish"], hold: ["draft", "hold"], release: ["draft", "release"], discard: ["draft", "discard"] };

// ---------- people ----------

/** The person's newest Update on any cadence page. */
function newestUpdate(ctx: Ctx, user: string) {
  let best: { project: string; cadence: string; period: string; footer: ReturnType<typeof footerOf> } | undefined;
  for (const [project, p] of Object.entries(ctx.team.projects))
    for (const cadence of p.cadences) {
      const period = periodsOf(project, cadence).reverse().find((d) => existsSync(pageFile(`${project}/${cadence}/${d}`, user)));
      if (!period || (best && best.period >= period)) continue;
      best = { project, cadence, period, footer: footerOf(readFileSync(pageFile(`${project}/${cadence}/${period}`, user), "utf8")) };
    }
  return best ?? null;
}

function people(ctx: Ctx) {
  const state = readState();
  const yesterday = addDays(ctx.today, -1);
  return ctx.team.team.members.map((user) => {
    const dir = join(paths.people, user);
    const date = existsSync(dir) ? readdirSync(dir).map((f) => f.replace(/\.md$/, "")).filter(isDate).sort().at(-1) : undefined;
    const me = user === ctx.local.user;
    const recentRun = me && state.last_run && Date.now() - Date.parse(state.last_run.at) < 86_400_000;
    const update = newestUpdate(ctx, user);
    return {
      user,
      me,
      lead: ctx.team.team.leads.includes(user),
      dayLog: date ? { date, preview: readFileSync(dayLogFile(user, date), "utf8").slice(0, 1500) } : null,
      update,
      run: me ? (state.last_run ?? null) : undefined,
      quiet: !(date && date >= yesterday) && !(update && update.period >= yesterday) && !recentRun,
    };
  });
}

// ---------- the header ----------

function about(ctx: Ctx) {
  return {
    team: ctx.team.team.name,
    user: ctx.local.user,
    today: ctx.today,
    members: ctx.team.team.members,
    mine: myProjects(ctx.team, ctx.local),
    projects: Object.fromEntries(
      Object.entries(ctx.team.projects).map(([id, p]) => [id, { name: p.name, cadences: p.cadences.filter((c) => ctx.cadences[c]).map((c) => ({ name: c, title: ctx.cadences[c].title })) }]),
    ),
    columns: ctx.team.status.columns,
    priority: ctx.team.priority,
    lastRun: readState().last_run ?? null,
    runsEveryMs: parseDuration(ctx.team.runs.every),
  };
}

// ---------- routing ----------

type Handler = (m: string[], body: any, url: URL) => unknown;
const routes: [string, RegExp, Handler][] = [
  ["GET", /^\/api\/context$/, () => about(context())],
  ["GET", /^\/api\/page\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/, ([p, c, d]) => readPage(context(), p, c, d)],
  ["PUT", /^\/api\/page\/([^/]+)\/([^/]+)\/([^/]+)$/, ([p, c, d], body) => saveNotes(context(), p, c, d, body)],
  ["POST", /^\/api\/page\/([^/]+)\/([^/]+)$/, ([p, c]) => {
    const ctx = context();
    cadenceOf(ctx.team, ctx.cadences, p, c);
    return { output: mustHouston(["page", p, c]), ...readPage(ctx, p, c) };
  }],
  ["GET", /^\/api\/board$/, (_, __, url) => board(context(), url.searchParams.has("refresh"))],
  ["GET", /^\/api\/issues\/([^/]+)\/([^/]+)\/([^/]+)$/, ([o, r, n]) => issue(refFrom(context(), o, r, n))],
  ["POST", /^\/api\/issues\/([^/]+)\/([^/]+)\/([^/]+)\/status$/, ([o, r, n], body) => setStatus(refFrom(context(), o, r, n), body.status)],
  ["GET", /^\/api\/review$/, (_, __, url) => review(context(), url.searchParams.has("refresh"))],
  ["POST", /^\/api\/review\/([^/]+)\/merge$/, ([n]) => merge(n)],
  ["GET", /^\/api\/draft$/, () => readDraft(context())],
  ["PUT", /^\/api\/draft$/, (_, body) => saveDraft(context(), body.text)],
  ["POST", /^\/api\/draft\/([^/]+)$/, ([action]) => {
    if (!DRAFT_ACTIONS[action]) throw new HttpError(404, `"${action}" is not something you can do to a draft.`);
    return { output: mustHouston(DRAFT_ACTIONS[action]), ...readDraft(context()) };
  }],
  ["GET", /^\/api\/people$/, () => people(context())],
  ["GET", /^\/api\/setup$/, () => ({ explain: houston(["explain"]), validate: houston(["validate"]) })],
];

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

/**
 * Only this app's own pages may call it: the Host must be ours (DNS rebinding), a present Origin
 * must be ours (other sites), and writes must be JSON, which a plain cross-site form can't send.
 */
function refuse(req: Request, port: number): string | undefined {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!hosts.includes(req.headers.get("host") ?? "")) return "This app only answers on 127.0.0.1.";
  const origin = req.headers.get("origin");
  if (origin && !hosts.some((h) => origin === `http://${h}`)) return "This app only answers its own pages.";
  if (req.method !== "GET" && req.method !== "HEAD" && !(req.headers.get("content-type") ?? "").startsWith("application/json"))
    return "Changes must be sent as application/json.";
}

async function handle(req: Request, port: number): Promise<Response> {
  const why = refuse(req, port);
  if (why) return json({ error: why }, 403);
  const url = new URL(req.url);

  if (req.method === "GET" && STATIC[url.pathname]) {
    return new Response(Bun.file(join(PUBLIC, STATIC[url.pathname])), {
      headers: { "Content-Security-Policy": "default-src 'self'; img-src 'self' data:", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache" },
    });
  }

  for (const [method, pattern, handler] of routes) {
    const m = pattern.exec(url.pathname);
    if (!m || method !== req.method) continue;
    try {
      const params = m.slice(1).map((s) => (s === undefined ? s : decodeURIComponent(s)));
      const body = method === "GET" ? {} : await req.json().catch(() => {
        throw new HttpError(400, "The request body isn't valid JSON.");
      });
      return json(await handler(params as string[], body ?? {}, url));
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      if (e instanceof HoustonError) return json({ error: e.message }, 400);
      console.error(e);
      return json({ error: `Something broke: ${(e as Error).message}` }, 500);
    }
  }
  return json({ error: `Nothing here: ${req.method} ${url.pathname}` }, 404);
}

/** Starts the app. `port: 0` picks a free port (tests); read it back from the returned server. */
export function createServer({ port }: { port: number }) {
  // ponytail: handlers use spawnSync, so one slow `houston publish` blocks other requests; fine for one person's app.
  return Bun.serve({ hostname: "127.0.0.1", port, fetch: (req, server) => handle(req, server.port ?? port) });
}
