// The person's files in the Houston repo: day logs, their section of each cadence period, the
// period's people's page, and the run footer under each section. Every write here goes through
// writeInRepo, which never follows a symlink or leaves the repo.
import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { periodDir, periodOf, renderPage, zoned, type Cadence } from "./cadence";
import type { Context, Local, Team } from "./config";
import { paths } from "./paths";
import { commitAndPush } from "./repo";
import type { SourceHealth } from "./state";
import { HoustonError } from "./util";

/**
 * Writes a file inside the Houston repo. Refuses a path outside it, or one where the file or any
 * folder on the way is a symlink: a teammate could commit a symlink that points at the person's
 * own files, and a run must never write through it.
 */
export function writeInRepo(file: string, text: string) {
  const rel = relative(paths.root, resolve(file));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new HoustonError(`Houston only writes inside the Houston repo; ${file} isn't.`);
  let p = paths.root;
  for (const part of rel.split(sep)) {
    p = join(p, part);
    if (lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink()) throw new HoustonError(`${relative(paths.root, p)} is a symlink, so Houston won't write ${rel} through it. Remove the link and try again.`);
  }
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

export const dayLogFile = (user: string, date: string) => join(paths.people, user, `${date}.md`);

/** The person's own file in a cadence period, from a target like storefront/daily/2026-11-13. */
export const pageFile = (target: string, user: string) => {
  const [project, cadence, period] = target.split("/");
  return join(paths.root, periodDir(project, cadence, period), `${user}.md`);
};

// ---------- the run footer: _run 09:00 · sources: github ok, sessions failed · not reviewed_ ----------

const FOOTER = /^_run (\d{2}:\d{2})((?: · .*)?)_$/;

export function footer(at: Date, tz: string, sources: SourceHealth, notReviewed: boolean): string {
  const health = Object.entries(sources).map(([k, v]) => `${k} ${v === "ok" ? "ok" : "failed"}`);
  return `_${[`run ${zoned(at, tz).time}`, ...(health.length ? [`sources: ${health.join(", ")}`] : []), ...(notReviewed ? ["not reviewed"] : [])].join(" · ")}_`;
}

/** Reads a footer line back, or undefined if the line isn't one. */
export function parseFooter(line: string): { time: string; sources: Record<string, string>; notReviewed: boolean } | undefined {
  const m = FOOTER.exec(line.trim());
  if (!m) return undefined;
  const parts = m[2].split(" · ").slice(1);
  const sources: Record<string, string> = {};
  for (const s of parts.find((p) => p.startsWith("sources: "))?.slice("sources: ".length).split(", ") ?? []) {
    const [name, health] = s.split(" ");
    if (name) sources[name] = health ?? "";
  }
  return { time: m[1], sources, notReviewed: parts.includes("not reviewed") };
}

/** A file's content without the run footer, so a merged rewrite doesn't stack old footers. */
export const stripFooter = (text: string) => text.split("\n").filter((l) => !parseFooter(l)).join("\n").trim();

// ---------- cadence periods ----------

/** Projects this person works in: those with a repo in their houston.local.yml (all, if none). */
export function myProjects(team: Team, local: Local): string[] {
  const mine = new Set(Object.keys(local.repos).map((r) => r.toLowerCase()));
  const ids = Object.keys(team.projects).filter((id) => team.projects[id].repos.some((r) => mine.has(r.repo.toLowerCase())));
  return ids.length ? ids : Object.keys(team.projects);
}

/** Cadence periods open on a date, for these projects. A daily cadence is only open on its scheduled days. */
export function openPeriods(ctx: Context, projects: string[], at: Date): { project: string; cadence: Cadence; period: string; target: string }[] {
  const { date, weekday } = zoned(at, ctx.local.timezone);
  return projects.flatMap((project) =>
    ctx.team.projects[project].cadences
      .map((name) => ctx.cadences[name])
      .filter((c) => c && (c.period !== "day" || c.schedule.days.includes(weekday)))
      .map((c) => ({ project, cadence: c, period: periodOf(c, date), target: `${project}/${c.name}/${periodOf(c, date)}` })),
  );
}

/** Makes sure a period's folder and its people's page exist. Returns the file if it was created. */
export function ensurePage(project: string, c: Cadence, period: string): string | undefined {
  const file = join(paths.root, periodDir(project, c.name, period), "_page.md");
  if (existsSync(file)) return undefined;
  writeInRepo(file, renderPage(c, { period, project }));
  return file;
}

/** Creates the pages of every cadence period open now; commits and pushes the new ones. */
export function ensureTodayPages(ctx: Context, now = new Date()): string[] {
  const files = openPeriods(ctx, Object.keys(ctx.team.projects), now)
    .map((o) => ensurePage(o.project, o.cadence, o.period))
    .filter((f): f is string => !!f);
  if (files.length) commitAndPush(files, `houston: pages for ${zoned(now, ctx.local.timezone).date}`);
  return files;
}
