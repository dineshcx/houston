// Cadence pages for the app: the people-written Notes and each member's Update as structured data
// (footer parsed, Blocked lines pulled out, a plain-word reason for a missing update), the list of
// periods, and saving the Notes in two steps: PUT writes the file (fast, for autosave), and a sync
// commits and pushes it, either when the app asks (POST …/sync) or after 30 s without a write.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atZoned, cadenceOf, isDate, nextOccurrence, nextPeriod, periodDir, periodOf, renderPage, type Cadence } from "../../src/lib/cadence";
import { dayLogFile, myProjects, pageFile, parseFooter, stripFooter, writeInRepo } from "../../src/lib/pages";
import { paths } from "../../src/lib/paths";
import { git } from "../../src/lib/repo";
import { hash, readState } from "../../src/lib/state";
import { parseDuration } from "../../src/lib/util";
import { context, dayLabel, HttpError, inWorker, mustHouston, serial, type Ctx } from "./common";

// ---------- reading updates ----------

export type Footer = { time: string; sources: Record<string, string>; notReviewed: boolean; problem: boolean; failed: string[] };

/** A run footer for the browser: when, each source's health, "not reviewed", and which sources failed. */
export function footerOf(text: string): Footer | null {
  const f = parseFooter(text.trimEnd().split("\n").at(-1) ?? "");
  if (!f) return null;
  const failed = Object.entries(f.sources).filter(([, h]) => h !== "ok").map(([name]) => name);
  return { ...f, problem: failed.length > 0, failed };
}

const REF = /[\w.-]+\/[\w.-]+#\d+/g;
export const refsIn = (text: string) => [...new Set(text.match(REF) ?? [])];

/** Lines that say nothing is blocked. */
const NOTHING = /^(nothing|none|no blockers?|not blocked|n\/?a|-|—)\b/i;

/** The lines under a "Blocked" heading (any level) that aren't "nothing", without their list marker. */
export function blockedLines(markdown: string): string[] {
  const out: string[] = [];
  let inBlocked = false;
  for (const line of markdown.split("\n")) {
    const h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      inBlocked = /^blocked\b/i.test(h[1].replace(/[*_]/g, ""));
      continue;
    }
    if (!inBlocked) continue;
    const text = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "").trim();
    if (text && !NOTHING.test(text.replace(/[*_]/g, ""))) out.push(text);
  }
  return out;
}

// ---------- what we know about each member from the repo ----------

type Seen = { dayLogs: string[]; lastDayLogFooter: Footer | null; newest: { project: string; cadence: string; period: string; footer: Footer | null } | null };

export function periodsOf(project: string, cadence: string): string[] {
  const dir = join(paths.projects, project, cadence);
  return existsSync(dir) ? readdirSync(dir).filter(isDate).sort() : [];
}

/**
 * The member's day logs and newest Update on any cadence page.
 * ponytail: walks every period folder per member per request; cache it if teams keep years of pages.
 */
export function seen(ctx: Ctx, user: string): Seen {
  const dir = join(paths.people, user);
  const dayLogs = existsSync(dir) ? readdirSync(dir).map((f) => f.replace(/\.md$/, "")).filter(isDate).sort() : [];
  const last = dayLogs.at(-1);
  let newest: Seen["newest"] = null;
  for (const [project, p] of Object.entries(ctx.team.projects))
    for (const cadence of p.cadences) {
      const period = periodsOf(project, cadence).reverse().find((d) => existsSync(pageFile(`${project}/${cadence}/${d}`, user)));
      if (!period || (newest && newest.period >= period)) continue;
      newest = { project, cadence, period, footer: footerOf(readFileSync(pageFile(`${project}/${cadence}/${period}`, user), "utf8")) };
    }
  return { dayLogs, lastDayLogFooter: last ? footerOf(readFileSync(dayLogFile(user, last), "utf8")) : null, newest };
}

/** The first meeting of a period (its cadence time), if it has one. */
export function meetingOf(ctx: Ctx, c: Cadence, period: string): Date | null {
  const tz = ctx.local.timezone;
  const first = nextOccurrence(c.schedule, new Date(atZoned(period, "00:00", tz).getTime() - 1), tz);
  return first && first < atZoned(nextPeriod(c, period), "00:00", tz) ? first : null;
}

/** When runs publish for that meeting: publish_deadline before it, under review_until_deadline. */
function publishBy(ctx: Ctx, meeting: Date): Date {
  return ctx.team.rules.publish_runs === "review_until_deadline" ? new Date(meeting.getTime() - parseDuration(ctx.team.rules.publish_deadline)) : meeting;
}

export type Reason = { kind: "not-due" | "draft-waiting" | "last-run-failed" | "never-ran" | "nothing-here" | "no-run-since" | "past-period"; text: string; since?: string };

/** Why a member has no Update on a page, in plain words, from what the repo (and, for you, your state) shows. */
export function missingReason(ctx: Ctx, user: string, project: string, c: Cadence, period: string, s: Seen): Reason {
  const me = user === ctx.local.user;
  const current = period === periodOf(c, ctx.today);
  if (!current) return { kind: "past-period", text: "No update for this period" };
  if (me) {
    const st = readState();
    const target = `${project}/${c.name}/${period}`;
    if (st.draft && existsSync(paths.draft) && readFileSync(paths.draft, "utf8").includes(`<!-- houston:page ${target} -->`)) {
      const when = st.draft.held ? "held until you release it" : st.draft.deadline ? `publishes ${hhmm(ctx, st.draft.deadline)}` : "waits for you to approve it";
      return { kind: "draft-waiting", text: `Your draft has it; ${when}` };
    }
    if (st.last_run?.outcome === "failed") return { kind: "last-run-failed", text: `Last run failed ${hhmm(ctx, st.last_run.at)}${st.last_run.note ? `: ${st.last_run.note}` : ""}` };
  }
  const last = [s.dayLogs.at(-1), s.newest?.period].filter((d): d is string => !!d).sort().at(-1);
  if (!last) return me ? { kind: "never-ran", text: "No run on this laptop yet. Run `houston run` or set your schedule." } : { kind: "never-ran", text: "Never ran on any laptop" };
  const meeting = meetingOf(ctx, c, period);
  if (meeting && c.writers.includes("runs") && ctx.now < publishBy(ctx, meeting)) return { kind: "not-due", text: `Not due yet: drafts publish by ${hhmm(ctx, publishBy(ctx, meeting))}` };
  if (last === ctx.today) return { kind: "nothing-here", text: "Ran today, with nothing for this page yet", since: last };
  const failed = s.lastDayLogFooter?.failed.length ? `; that run couldn't read ${s.lastDayLogFooter.failed.join(", ")}` : "";
  return { kind: "no-run-since", text: `No run since ${dayLabel(last)}${failed}`, since: last };
}

const hhmm = (ctx: Ctx, t: string | Date) =>
  new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: ctx.local.timezone });

// ---------- one page ----------

function checkPeriod(c: Cadence, period: string) {
  if (!isDate(period) || periodOf(c, period) !== period) throw new HttpError(400, `"${period}" is not the first day of a ${c.title} period.`);
}

const notesFile = (project: string, cadence: string, period: string) => join(paths.root, periodDir(project, cadence, period), "_page.md");

/** Notes that say more than the cadence's starting headings. */
const hasNotes = (c: Cadence, project: string, period: string, text: string | null) => !!text && text.trim() !== renderPage(c, { period, project }).trim();

/** Who wrote an Update in a period folder. */
const writersIn = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "_page.md").map((f) => f.slice(0, -3)) : []);

export type PageUpdate = {
  user: string;
  me: boolean;
  lead: boolean;
  missing: boolean;
  body?: string;
  footer?: Footer | null;
  blocked?: string[];
  refs?: string[];
  reason?: Reason;
};

/** Every member's Update in a period (plus anyone else who wrote one), in team order. */
export function updatesOf(ctx: Ctx, project: string, c: Cadence, period: string, seenOf: (u: string) => Seen): PageUpdate[] {
  const dir = join(paths.root, periodDir(project, c.name, period));
  const writers = writersIn(dir);
  return [...new Set([...ctx.team.team.members, ...writers])].map((user) => {
    const who = { user, me: user === ctx.local.user, lead: ctx.team.team.leads.includes(user) };
    if (!writers.includes(user)) return { ...who, missing: true, reason: missingReason(ctx, user, project, c, period, seenOf(user)) };
    const text = readFileSync(pageFile(`${project}/${c.name}/${period}`, user), "utf8");
    const body = stripFooter(text);
    return { ...who, missing: false, body, footer: footerOf(text), blocked: blockedLines(body), refs: refsIn(body) };
  });
}

export function countsOf(updates: PageUpdate[]) {
  const present = updates.filter((u) => !u.missing);
  return {
    members: updates.length,
    published: present.length,
    clean: present.filter((u) => !u.footer?.problem && !u.footer?.notReviewed).length,
    notReviewed: present.filter((u) => u.footer?.notReviewed).length,
    failedSource: present.filter((u) => u.footer?.problem).length,
    missing: updates.length - present.length,
    blocked: present.reduce((n, u) => n + (u.blocked?.length ?? 0), 0),
  };
}

/** A memo of seen() for one request. */
export const seenMemo = (ctx: Ctx) => {
  const memo = new Map<string, Seen>();
  return (user: string) => memo.get(user) ?? memo.set(user, seen(ctx, user)).get(user)!;
};

/** Notes files written but not yet pushed: the commit message and the idle timer that will sync them. */
const pending = new Map<string, { message: string; timer?: ReturnType<typeof setTimeout> }>();

/** One period of one project's cadence, assembled for the page screen. */
export function readPage(ctx: Ctx, project: string, cadence: string, wanted?: string) {
  const c = cadenceOf(ctx.team, ctx.cadences, project, cadence);
  const current = periodOf(c, ctx.today);
  const period = wanted ?? current;
  checkPeriod(c, period);
  const dir = join(paths.root, periodDir(project, cadence, period));
  const exists = existsSync(dir);
  const file = notesFile(project, cadence, period);
  const notes = existsSync(file) ? readFileSync(file, "utf8") : null;
  const updates = exists ? updatesOf(ctx, project, c, period, seenMemo(ctx)) : [];
  const all = [...new Set([...periodsOf(project, cadence), current])].filter((p) => p <= current).sort();
  const meeting = meetingOf(ctx, c, period);
  return {
    project,
    projectName: ctx.team.projects[project].name,
    cadence: { name: c.name, title: c.title, period: c.period, schedule: c.schedule, writers: c.writers },
    period,
    label: dayLabel(period),
    current,
    isCurrent: period === current,
    frozen: ctx.today >= nextPeriod(c, period),
    exists,
    meetsAt: meeting?.toISOString() ?? null,
    publishBy: meeting && c.writers.includes("runs") ? publishBy(ctx, meeting).toISOString() : null,
    notes,
    /** Sent back on save, so a save can't overwrite a teammate's edit made since this was loaded. */
    notesHash: hash(notes ?? ""),
    /** Written on this laptop but not yet committed and pushed. */
    notesUnpushed: pending.has(file) || (notes !== null && git(["status", "--porcelain", "--", file]).stdout !== ""),
    hasNotes: hasNotes(c, project, period, notes),
    prev: all.filter((p) => p < period).at(-1) ?? null,
    next: all.find((p) => p > period) ?? null,
    periods: all.reverse().map((p) => periodInfo(ctx, project, c, p)),
    counts: countsOf(updates),
    blocked: updates.flatMap((u) => (u.blocked ?? []).map((text) => ({ user: u.user, text, refs: refsIn(text) }))),
    updates,
  };
}

/** One row of the periods list: which periods have notes and how many updates. */
function periodInfo(ctx: Ctx, project: string, c: Cadence, period: string) {
  const dir = join(paths.root, periodDir(project, c.name, period));
  const file = notesFile(project, c.name, period);
  const notes = existsSync(file) ? readFileSync(file, "utf8") : null;
  const writers = writersIn(dir);
  return {
    period,
    label: dayLabel(period),
    current: period === periodOf(c, ctx.today),
    frozen: ctx.today >= nextPeriod(c, period),
    exists: existsSync(dir),
    hasNotes: hasNotes(c, project, period, notes),
    updates: writers.length,
    members: new Set([...ctx.team.team.members, ...writers]).size,
  };
}

// ---------- today's pages, for the home screen ----------

/** Every project × cadence with a period open today (a daily cadence only on its days), with counts. */
export function todaysPages(ctx: Ctx) {
  const mine = myProjects(ctx.team, ctx.local);
  const seenOf = seenMemo(ctx);
  const weekday = new Date(`${ctx.today}T00:00:00Z`).getUTCDay();
  return Object.entries(ctx.team.projects).flatMap(([project, p]) =>
    p.cadences
      .map((name) => ctx.cadences[name])
      .filter((c) => c && (c.period !== "day" || c.schedule.days.includes(weekday)))
      .map((c) => {
        const period = periodOf(c, ctx.today);
        const exists = existsSync(join(paths.root, periodDir(project, c.name, period)));
        const file = notesFile(project, c.name, period);
        const updates = exists ? updatesOf(ctx, project, c, period, seenOf) : [];
        const meeting = meetingOf(ctx, c, period);
        return {
          project,
          projectName: p.name,
          mine: mine.includes(project),
          cadence: c.name,
          cadenceTitle: c.title,
          period,
          exists,
          meetsAt: meeting?.toISOString() ?? null,
          meetsToday: c.schedule.days.includes(weekday),
          hasNotes: hasNotes(c, project, period, existsSync(file) ? readFileSync(file, "utf8") : null),
          counts: exists ? countsOf(updates) : { members: ctx.team.team.members.length, published: 0, clean: 0, notReviewed: 0, failedSource: 0, missing: ctx.team.team.members.length, blocked: 0 },
          updates: updates.map((u) => ({ user: u.user, state: u.missing ? "missing" : u.footer?.problem ? "failed-source" : u.footer?.notReviewed ? "not-reviewed" : "published", reason: u.reason?.text ?? null })),
          /** Each member's Blocked lines on this page. */
          blockedBy: Object.fromEntries(updates.filter((u) => u.blocked?.length).map((u) => [u.user, u.blocked!])),
        };
      }),
  );
}

// ---------- saving the Notes ----------

const SYNC_IDLE_MS = 30_000;

/**
 * Writes the Notes file only: no git, no network, so the app can save as the person types.
 * Refused (409) when the file changed since the copy the person is editing (`hash`). The commit and
 * push follow in syncNotes, 30 s after the last write or when the app asks.
 */
export function writeNotes(ctx: Ctx, project: string, cadence: string, period: string, body: { text?: unknown; hash?: unknown }) {
  if (typeof body.text !== "string" || typeof body.hash !== "string") throw new HttpError(400, 'Send the notes as { text: "…", hash: "…" }.');
  const c = cadenceOf(ctx.team, ctx.cadences, project, cadence);
  checkPeriod(c, period);
  if (ctx.today >= nextPeriod(c, period)) throw new HttpError(409, "This period is frozen because the next one has started. Past pages don't change.");
  const file = notesFile(project, cadence, period);
  if (!existsSync(file)) throw new HttpError(409, "This period has no page yet. Start it first.");
  const now = readFileSync(file, "utf8");
  if (hash(now) !== body.hash)
    throw new HttpError(409, "These notes changed since you opened them (a teammate's edit came in). Reload theirs, or copy your text and apply it again.", { theirs: now, hash: hash(now) });
  const text = body.text.endsWith("\n") ? body.text : `${body.text}\n`;
  if (text !== now) {
    writeInRepo(file, text);
    const message = `houston: notes ${project}/${cadence}/${period}`;
    clearTimeout(pending.get(file)?.timer);
    const timer = setTimeout(() => syncFile(file).catch((e) => console.error(`Couldn't push ${project}/${cadence}/${period}: ${e.message}`)), SYNC_IDLE_MS);
    pending.set(file, { message, timer });
  }
  const h = hash(text);
  // notesHash: the same value under the name the old screen reads.
  return { hash: h, notesHash: h, unpushed: pending.has(file), syncInMs: pending.has(file) ? SYNC_IDLE_MS : null };
}

type SyncResult = { conflict: boolean; committed?: boolean; pushed?: boolean; note?: string; hash: string; mine?: string; theirs?: string; backup?: string };

function syncFile(file: string, message = pending.get(file)?.message ?? "houston: notes"): Promise<SyncResult> {
  clearTimeout(pending.get(file)?.timer);
  pending.delete(file);
  return serial(() => inWorker<SyncResult>("syncNotes", file, message)).catch((e) => {
    // Still not pushed: keep it on the list so the next sync or shutdown tries again.
    if (!pending.has(file)) pending.set(file, { message });
    throw e;
  });
}

/** Commits and pushes the Notes now. 409 with both texts when a teammate changed them meanwhile. */
export async function syncNotes(ctx: Ctx, project: string, cadence: string, period: string) {
  checkPeriod(cadenceOf(ctx.team, ctx.cadences, project, cadence), period);
  const file = notesFile(project, cadence, period);
  if (!existsSync(file)) throw new HttpError(404, "This period has no page yet.");
  const r = await syncFile(file, `houston: notes ${project}/${cadence}/${period}`);
  if (r.conflict)
    throw new HttpError(409, "A teammate changed these notes and pushed first. Their version is on the page now; yours came back with this error so you can merge it.", {
      theirs: r.theirs,
      hash: r.hash,
      mine: r.mine,
      backup: r.backup,
    });
  return r;
}

/** On shutdown: push whatever was written and not yet pushed. */
export async function flushNotes() {
  await Promise.allSettled([...pending.keys()].map((file) => syncFile(file)));
}

/** Makes the page for a period through the CLI (`houston page`), then returns it. */
export async function startPage(project: string, cadence: string) {
  const ctx = context();
  cadenceOf(ctx.team, ctx.cadences, project, cadence);
  const output = await serial(() => mustHouston(["page", project, cadence]));
  return { output, ...readPage(context(), project, cadence) };
}

