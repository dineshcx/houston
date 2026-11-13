// The local app's server: a JSON API plus three static files, on 127.0.0.1 only.
// It reads the Houston repo and GitHub; every write goes through the shared core or the houston
// CLI, so the team's rules are enforced in one place and never re-implemented here.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addDays, loadCadences, nextPeriod, periodOf, zoned, type Cadence } from "../src/lib/cadence";
import { STATUSES, loadLocal, loadTeam, teamRepos, type Local, type Team } from "../src/lib/config";
import { github, refText, type Issue, type IssueRef } from "../src/lib/github";
import { SUMMARY_END, SUMMARY_START, assertTeamRepo, readSummary } from "../src/lib/issues";
import { paths } from "../src/lib/paths";
import { commitAndPush, git, houstonRepo } from "../src/lib/repo";
import { hash, readState } from "../src/lib/state";
import { HoustonError, parseDuration, sh } from "../src/lib/util";

const PUBLIC = join(import.meta.dir, "public");
const STATIC: Record<string, string> = { "/": "index.html", "/index.html": "index.html", "/app.js": "app.js", "/style.css": "style.css" };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const BOARD_TTL_MS = 60_000;

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---------- what every request needs: the team, the person, today ----------

type Ctx = { team: Team; cadences: Record<string, Cadence>; local?: Local; user?: string; tz: string; today: string };

/** Re-read on every request so edits to houston.yml or cadences/ show without a restart. */
function context(): Ctx {
  const cadences = loadCadences();
  const team = loadTeam(paths.team, Object.keys(cadences));
  let local: Local | undefined;
  try {
    local = loadLocal();
  } catch {
    // Not linked yet: the app still shows the team, just without "you".
  }
  const tz = local?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return { team, cadences, local, user: local?.user, tz, today: zoned(new Date(), tz).date };
}

/** Runs the houston CLI the way a person would, from the repo root with the same environment. */
function houston(args: string[]): { ok: boolean; output: string } {
  const r = sh([process.execPath, join(paths.core, "src/cli.ts"), ...args], { cwd: paths.root });
  return { ok: r.ok, output: [r.stdout, r.stderr].filter(Boolean).join("\n") };
}

function mustHouston(args: string[]): string {
  const r = houston(args);
  if (!r.ok) throw new HttpError(422, r.output || `houston ${args[0]} failed.`);
  return r.output;
}

// ---------- validation of anything that becomes a path ----------

function cadenceOf(ctx: Ctx, project: string, cadence: string): Cadence {
  const p = ctx.team.projects[project];
  if (!p) throw new HttpError(404, `There is no project "${project}" in houston.yml.`);
  if (!p.cadences.includes(cadence) || !ctx.cadences[cadence]) throw new HttpError(404, `Project ${project} has no cadence "${cadence}".`);
  return ctx.cadences[cadence];
}

function isDate(s: string) {
  if (!DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function checkPeriod(c: Cadence, period: string) {
  if (!isDate(period) || periodOf(c, period) !== period) throw new HttpError(400, `"${period}" is not the first day of a ${c.title} period.`);
}

function refFrom(ctx: Ctx, owner: string, repo: string, number: string): IssueRef {
  if (!/^\d+$/.test(number)) throw new HttpError(400, `"${number}" is not an issue number.`);
  const ref = { repo: `${owner}/${repo}`, number: Number(number) };
  assertTeamRepo(ctx.team, ref.repo);
  return ref;
}

// ---------- cadence pages ----------

const FOOTER = /^_run .+_$/;

/** A person's section: their run's text and the footer the publish step appends (`_run 09:00 · sources: … · not reviewed_`). */
function personSection(text: string) {
  const lines = text.trimEnd().split("\n");
  const last = lines.at(-1) ?? "";
  if (!FOOTER.test(last)) return { body: text, footer: null };
  const sources = /sources: ([^·]*)/.exec(last)?.[1].split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  return {
    body: lines.slice(0, -1).join("\n").trimEnd(),
    footer: last.slice(1, -1),
    notReviewed: last.includes("not reviewed"),
    sourceProblem: sources.some((s) => !s.endsWith(" ok")),
  };
}

function periodsOf(project: string, cadence: string): string[] {
  const dir = join(paths.projects, project, cadence);
  return existsSync(dir) ? readdirSync(dir).filter(isDate).sort() : [];
}

function readPage(ctx: Ctx, project: string, cadence: string, wanted?: string) {
  const c = cadenceOf(ctx, project, cadence);
  const current = periodOf(c, ctx.today);
  const period = wanted ?? current;
  checkPeriod(c, period);
  const dir = join(paths.projects, project, cadence, period);
  const exists = existsSync(dir);
  const writers = exists ? readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "_page.md").map((f) => f.slice(0, -3)) : [];
  const people = [...new Set([...ctx.team.team.members, ...writers])].map((user) =>
    writers.includes(user) ? { user, ...personSection(readFileSync(join(dir, `${user}.md`), "utf8")) } : { user, missing: true },
  );
  const periods = periodsOf(project, cadence);
  const pageFile = join(dir, "_page.md");
  return {
    project,
    cadence: { name: c.name, title: c.title, period: c.period },
    period,
    current,
    frozen: ctx.today >= nextPeriod(c, period),
    exists,
    page: existsSync(pageFile) ? readFileSync(pageFile, "utf8") : null,
    prev: periods.filter((p) => p < period).at(-1) ?? null,
    next: periods.find((p) => p > period) ?? null,
    people: exists ? people : [],
  };
}

function savePage(ctx: Ctx, project: string, cadence: string, period: string, text: unknown) {
  if (typeof text !== "string") throw new HttpError(400, "Send the page as { text: \"…\" }.");
  const page = readPage(ctx, project, cadence, period);
  if (page.frozen) throw new HttpError(409, "This period is frozen because the next one has started. Past pages don't change.");
  if (!page.exists) throw new HttpError(409, "This period has no page yet. Create it first.");
  const file = join(paths.projects, project, cadence, period, "_page.md");
  writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`);
  return { saved: true, ...commitAndPush([file], `houston: page ${project}/${cadence}/${period}`) };
}

// ---------- the board ----------

type Card = { ref: string; repo: string; number: number; project: string; title: string; url: string; assignees: string[]; status: string | null; priority: string | null; hasSummary: boolean };

let boardCache: { at: number; cards: Card[]; errors: string[] } | undefined;

function toCard(i: Issue, project: string): Card {
  return {
    ref: refText(i),
    repo: i.repo,
    number: i.number,
    project,
    title: i.title,
    url: i.url,
    assignees: i.assignees,
    status: i.labels.find((l) => l.startsWith("status:"))?.slice("status:".length) ?? null,
    priority: i.labels.find((l) => /^p[0-3]$/.test(l)) ?? null,
    hasSummary: readSummary(i.body) !== undefined,
  };
}

function board(ctx: Ctx, refresh: boolean) {
  if (refresh || !boardCache || Date.now() - boardCache.at > BOARD_TTL_MS) {
    const cards: Card[] = [];
    const errors: string[] = [];
    for (const r of teamRepos(ctx.team)) {
      try {
        cards.push(...github().issues(r.repo).map((i) => toCard(i, r.project)));
      } catch (e) {
        errors.push(`${r.repo}: ${(e as Error).message}`);
      }
    }
    boardCache = { at: Date.now(), cards, errors };
  }
  const { at, cards, errors } = boardCache;
  const labels = ctx.team.status.columns.map((c) => c.label as string);
  return {
    fetchedAt: new Date(at).toISOString(),
    errors,
    columns: [
      ...ctx.team.status.columns.map((c) => ({ label: c.label, name: c.name, cards: cards.filter((i) => i.status === c.label) })),
      { label: null, name: "No status", cards: cards.filter((i) => !i.status || !labels.includes(i.status)) },
    ],
  };
}

function setStatus(ctx: Ctx, ref: IssueRef, status: unknown) {
  if (!STATUSES.includes(status as (typeof STATUSES)[number])) throw new HttpError(400, `"${status}" is not a status. Use one of: ${STATUSES.join(", ")}.`);
  const output = mustHouston(["labels", refText(ref), `status:${status}`]);
  boardCache = undefined;
  return { output };
}

function issue(ref: IssueRef) {
  const i = github().issue(ref);
  const s = i.body.indexOf(SUMMARY_START);
  const e = i.body.indexOf(SUMMARY_END);
  const rest = s >= 0 && e > s ? i.body.slice(0, s) + i.body.slice(e + SUMMARY_END.length) : i.body;
  return { ref: refText(i), title: i.title, url: i.url, state: i.state, labels: i.labels, assignees: i.assignees, summary: readSummary(i.body) ?? null, body: rest.trim() };
}

// ---------- intake review ----------

function defaultBranch(): string {
  const r = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  return r.ok ? r.stdout.replace(/^origin\//, "") : "main";
}

/** The notes and proposal files an intake PR adds, read from its branch without checking it out. */
function proposalFiles(base: string, branch: string) {
  if (!/^[\w][\w./-]*$/.test(branch) || branch.includes("..")) return { error: `The branch name "${branch}" looks unusual, so Houston didn't fetch it.` };
  const fetched = git(["fetch", "--quiet", "origin", branch]);
  if (!fetched.ok) return { error: `Couldn't fetch ${branch}: ${fetched.stderr}` };
  const names = git(["diff", "--name-only", `origin/${base}...origin/${branch}`]).stdout.split("\n").filter(Boolean);
  const show = (path: string) => git(["show", `origin/${branch}:${path}`]).stdout;
  const proposalPath = names.find((n) => /^proposals\/.+\.ya?ml$/.test(n));
  let proposal: unknown = null;
  let proposalError: string | undefined;
  if (proposalPath) {
    try {
      proposal = Bun.YAML.parse(show(proposalPath));
    } catch (e) {
      proposalError = `${proposalPath} is not valid YAML: ${(e as Error).message}`;
    }
  }
  return {
    proposalPath: proposalPath ?? null,
    proposal,
    proposalError,
    notes: names.filter((n) => n.endsWith(".md")).map((path) => ({ path, text: show(path) })),
  };
}

function review() {
  const repo = houstonRepo();
  if (!repo) return { repo: null, prs: [] };
  const base = defaultBranch();
  const prs = github().pullRequests(repo, { label: "houston:intake" });
  return { repo, prs: prs.map((p) => ({ number: p.number, title: p.title, author: p.author, url: p.url, branch: p.branch, updatedAt: p.updatedAt, ...proposalFiles(base, p.branch) })) };
}

function merge(number: string) {
  const repo = houstonRepo();
  if (!repo) throw new HttpError(409, "This Houston repo has no GitHub origin, so there is nothing to merge.");
  if (!/^\d+$/.test(number)) throw new HttpError(400, `"${number}" is not a pull request number.`);
  github().mergePullRequest(repo, Number(number));
  return { merged: true };
}

// ---------- my draft ----------

function readDraft() {
  const exists = existsSync(paths.draft);
  const text = exists ? readFileSync(paths.draft, "utf8") : "";
  const d = readState().draft;
  return { exists, text, draft: d ?? null, edited: !!d && exists && hash(text) !== d.agent_hash };
}

function saveDraft(text: unknown) {
  if (typeof text !== "string") throw new HttpError(400, "Send the draft as { text: \"…\" }.");
  if (!existsSync(paths.draft)) throw new HttpError(404, "There's no draft to save. Your next run makes one.");
  writeFileSync(paths.draft, text);
  return readDraft();
}

const DRAFT_ACTIONS: Record<string, string[]> = { publish: ["publish"], hold: ["draft", "hold"], release: ["draft", "release"], discard: ["draft", "discard"] };

// ---------- people ----------

/** The person's newest section on any cadence page, by period. */
function newestSection(ctx: Ctx, user: string) {
  let best: { project: string; cadence: string; period: string; footer: string | null; notReviewed?: boolean; sourceProblem?: boolean } | undefined;
  for (const [project, p] of Object.entries(ctx.team.projects))
    for (const cadence of p.cadences) {
      const period = periodsOf(project, cadence).reverse().find((d) => existsSync(join(paths.projects, project, cadence, d, `${user}.md`)));
      if (!period || (best && best.period >= period)) continue;
      const { footer, notReviewed, sourceProblem } = personSection(readFileSync(join(paths.projects, project, cadence, period, `${user}.md`), "utf8"));
      best = { project, cadence, period, footer, notReviewed, sourceProblem };
    }
  return best ?? null;
}

function people(ctx: Ctx) {
  const state = readState();
  const yesterday = addDays(ctx.today, -1);
  return ctx.team.team.members.map((user) => {
    const dir = join(paths.people, user);
    const latest = existsSync(dir) ? readdirSync(dir).filter((f) => DATE.test(f.slice(0, -3)) && f.endsWith(".md")).sort().at(-1) : undefined;
    const date = latest?.slice(0, -3);
    const me = user === ctx.user;
    const recentRun = me && state.last_run && Date.now() - Date.parse(state.last_run.at) < 86_400_000;
    const section = newestSection(ctx, user);
    return {
      user,
      me,
      lead: ctx.team.team.leads.includes(user),
      dayLog: latest ? { date, preview: readFileSync(join(dir, latest), "utf8").slice(0, 1500) } : null,
      section,
      run: me ? (state.last_run ?? null) : undefined,
      quiet: !(date && date >= yesterday) && !(section && section.period >= yesterday) && !recentRun,
    };
  });
}

// ---------- the header ----------

function about(ctx: Ctx) {
  return {
    team: ctx.team.team.name,
    user: ctx.user ?? null,
    today: ctx.today,
    members: ctx.team.team.members,
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
  ["PUT", /^\/api\/page\/([^/]+)\/([^/]+)\/([^/]+)$/, ([p, c, d], body) => savePage(context(), p, c, d, body.text)],
  ["POST", /^\/api\/page\/([^/]+)\/([^/]+)$/, ([p, c]) => {
    const ctx = context();
    cadenceOf(ctx, p, c);
    return { output: mustHouston(["page", p, c]), ...readPage(ctx, p, c) };
  }],
  ["GET", /^\/api\/board$/, (_, __, url) => board(context(), url.searchParams.has("refresh"))],
  ["GET", /^\/api\/issues\/([^/]+)\/([^/]+)\/([^/]+)$/, ([o, r, n]) => issue(refFrom(context(), o, r, n))],
  ["POST", /^\/api\/issues\/([^/]+)\/([^/]+)\/([^/]+)\/status$/, ([o, r, n], body) => {
    const ctx = context();
    return setStatus(ctx, refFrom(ctx, o, r, n), body.status);
  }],
  ["GET", /^\/api\/review$/, () => review()],
  ["POST", /^\/api\/review\/([^/]+)\/merge$/, ([n]) => merge(n)],
  ["GET", /^\/api\/draft$/, () => readDraft()],
  ["PUT", /^\/api\/draft$/, (_, body) => saveDraft(body.text)],
  ["POST", /^\/api\/draft\/([^/]+)$/, ([action]) => {
    if (!DRAFT_ACTIONS[action]) throw new HttpError(404, `"${action}" is not something you can do to a draft.`);
    return { output: mustHouston(DRAFT_ACTIONS[action]), ...readDraft() };
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
