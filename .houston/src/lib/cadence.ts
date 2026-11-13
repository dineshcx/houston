// Cadences: recurring pages (daily standup, weekly sync, sprint, KPI check) defined one per file in
// cadences/<name>.md as YAML front matter plus the template each person's section follows.
// A period is identified by its first day (YYYY-MM-DD), which keeps folders sortable for every kind.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Team } from "./config";
import { paths } from "./paths";
import { HoustonError, parseDuration } from "./util";

export type Period = "day" | "week" | "sprint" | "month";
export type Schedule = { days: number[]; time: string }; // days: 0 = Sunday … 6 = Saturday; time: HH:MM

export type Cadence = {
  name: string;
  title: string;
  schedule: Schedule;
  period: Period;
  sprint?: { start: string; days: number };
  writers: ("runs" | "people")[];
  /** What each person's run writes for a period; shown to the run's agent as the shape to follow. */
  template: string;
  /** The Notes (_page.md) a new period starts with. Only {{title}}, {{period}} and {{project}} are allowed. */
  page: string;
};

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DEFAULT_PAGE = "# {{title}}, {{period}}\n\n## Agenda\n\n## Notes\n\n## Decisions\n\n## Action items\n";

/** "Mon-Fri 10:00", "Mon 09:30", "Mon,Thu 16:00", "daily 09:00" */
export function parseSchedule(text: string): Schedule {
  const m = /^\s*([A-Za-z,\- ]+?)\s+(\d{1,2}):(\d{2})\s*$/.exec(text ?? "");
  if (!m) throw new HoustonError(`schedule "${text}" should look like "Mon-Fri 10:00" or "Mon 09:30"`);
  const [hh, mm] = [Number(m[2]), Number(m[3])];
  if (hh > 23 || mm > 59) throw new HoustonError(`schedule "${text}" has an impossible time`);
  const day = (d: string) => {
    const i = DAY_NAMES.findIndex((n) => n.toLowerCase() === d.trim().slice(0, 3).toLowerCase());
    if (i < 0) throw new HoustonError(`schedule "${text}": "${d}" is not a day (Mon, Tue, …)`);
    return i;
  };
  const days = new Set<number>();
  for (const part of m[1].split(",")) {
    const p = part.trim().toLowerCase();
    if (p === "daily" || p === "every day") [0, 1, 2, 3, 4, 5, 6].forEach((d) => days.add(d));
    else if (p === "weekdays") [1, 2, 3, 4, 5].forEach((d) => days.add(d));
    else if (p.includes("-")) {
      const [a, b] = p.split("-").map(day);
      for (let d = a; ; d = (d + 1) % 7) {
        days.add(d);
        if (d === b) break;
      }
    } else days.add(day(p));
  }
  return { days: [...days].sort(), time: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}` };
}


// ---------- dates in a timezone ----------

/** The calendar date (YYYY-MM-DD), weekday and HH:MM of an instant, in a timezone. */
export function zoned(at: Date, tz: string): { date: string; weekday: number; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday: DAY_NAMES.indexOf(parts.weekday), time: `${parts.hour}:${parts.minute}` };
}

/** "2026-11-13 09:30", in the person's timezone. The one way Houston shows a time. */
export function formatAt(at: Date | string, tz: string): string {
  const z = zoned(new Date(at), tz);
  return `${z.date} ${z.time}`;
}

/** True for a real calendar date written YYYY-MM-DD. */
export function isDate(text: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && new Date(`${text}T00:00:00Z`).toISOString().startsWith(text);
}

/** The instant a wall-clock time happens in a timezone (DST-safe for any time that exists). */
export function atZoned(date: string, time: string, tz: string): Date {
  const guess = Date.parse(`${date}T${time}:00Z`);
  const offsetAt = (t: number) => {
    const z = zoned(new Date(t), tz);
    return Date.parse(`${z.date}T${z.time}:00Z`) - t;
  };
  const first = guess - offsetAt(guess);
  return new Date(guess - offsetAt(first));
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

/** The next time a schedule fires strictly after `after`, in the person's timezone. */
export function nextOccurrence(s: Schedule, after: Date, tz: string): Date | undefined {
  const today = zoned(after, tz).date;
  for (let i = 0; i <= 14; i++) {
    const date = addDays(today, i);
    if (!s.days.includes(weekdayOf(date))) continue;
    const at = atZoned(date, s.time, tz);
    if (at > after) return at;
  }
  return undefined;
}

/** The first day of the period that contains `date`. This is the period's folder name. */
export function periodOf(c: Cadence, date: string): string {
  switch (c.period) {
    case "day":
      return date;
    case "week":
      return addDays(date, -((weekdayOf(date) + 6) % 7));
    case "month":
      return `${date.slice(0, 7)}-01`;
    case "sprint": {
      const { start, days } = c.sprint!;
      const diff = Math.round((Date.parse(date) - Date.parse(start)) / 86_400_000);
      return addDays(start, Math.floor(diff / days) * days);
    }
  }
}

/** The period after the one starting at `period`. */
export function nextPeriod(c: Cadence, period: string): string {
  switch (c.period) {
    case "day":
      return addDays(period, 1);
    case "week":
      return addDays(period, 7);
    case "sprint":
      return addDays(period, c.sprint!.days);
    case "month": {
      const [y, m] = period.split("-").map(Number);
      return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
    }
  }
}

// ---------- cadence files ----------

export function splitFrontMatter(text: string): { data: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { data: {}, body: text };
  return { data: (Bun.YAML.parse(m[1]) as Record<string, unknown>) ?? {}, body: m[2] };
}

const ALLOWED = ["title", "schedule", "period", "sprint_start", "sprint_length", "writers", "page"];

/** Parses one cadence file. Throws with every problem in plain words. */
export function parseCadence(name: string, text: string): Cadence {
  const where = `cadences/${name}.md`;
  let fm: ReturnType<typeof splitFrontMatter>;
  try {
    fm = splitFrontMatter(text);
  } catch (e) {
    throw new HoustonError(`${where}: the front matter is not valid YAML: ${(e as Error).message}`);
  }
  const { data, body } = fm;
  const errors: string[] = [];
  for (const k of Object.keys(data)) if (!ALLOWED.includes(k)) errors.push(`unknown key "${k}". Allowed: ${ALLOWED.join(", ")}`);
  let schedule: Schedule | undefined;
  try {
    schedule = parseSchedule(String(data.schedule ?? ""));
  } catch (e) {
    errors.push((e as Error).message);
  }
  const period = (data.period ?? "day") as Period;
  if (!["day", "week", "sprint", "month"].includes(period)) errors.push(`period "${period}" should be day, week, sprint or month`);
  let sprint: Cadence["sprint"];
  if (period === "sprint") {
    const start = String(data.sprint_start ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) errors.push("a sprint cadence needs sprint_start: YYYY-MM-DD (the first day of any sprint)");
    try {
      sprint = { start, days: Math.round(parseDuration(String(data.sprint_length ?? "2w")) / 86_400_000) };
    } catch (e) {
      errors.push(`sprint_length: ${(e as Error).message}`);
    }
  }
  const writers = (data.writers ?? ["runs", "people"]) as Cadence["writers"];
  if (!Array.isArray(writers) || writers.some((w) => w !== "runs" && w !== "people")) errors.push('writers should be a list of "runs" and/or "people"');
  const page = String(data.page ?? DEFAULT_PAGE);
  for (const v of page.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) if (!["title", "period", "project"].includes(v[1])) errors.push(`page uses {{${v[1]}}}; only {{title}}, {{period}} and {{project}} exist`);
  if (errors.length) throw new HoustonError(`${where} has problems:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  return { name, title: String(data.title ?? name), schedule: schedule!, period, sprint, writers, template: body.trim(), page };
}

/** cadences/<name>.md, where name is a lowercase id. Anything else there (a README) is ignored. */
export const isCadenceFile = (f: string) => /^[a-z0-9][a-z0-9-]*\.md$/.test(f);

/** All cadences in cadences/, by name. */
export function loadCadences(dir = paths.cadences): Record<string, Cadence> {
  if (!existsSync(dir)) return {};
  const out: Record<string, Cadence> = {};
  for (const f of readdirSync(dir).filter(isCadenceFile).sort()) {
    const name = basename(f, ".md");
    out[name] = parseCadence(name, readFileSync(join(dir, f), "utf8"));
  }
  return out;
}

/** Fills a page template. Unknown variables were already refused by parseCadence. */
export function renderPage(c: Cadence, vars: { period: string; project: string }): string {
  return c.page.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => ({ title: c.title, ...vars })[k as "title" | "period" | "project"]);
}

/** A project's cadence by name, or a plain-words error naming what exists. */
export function cadenceOf(team: Team, cadences: Record<string, Cadence>, project: string, name: string): Cadence {
  const p = team.projects[project];
  if (!p) throw new HoustonError(`There is no project "${project}". Projects: ${Object.keys(team.projects).join(", ")}.`);
  const c = cadences[name];
  if (!c || !p.cadences.includes(name)) throw new HoustonError(`Project ${project} has no cadence "${name}". Its cadences: ${p.cadences.join(", ") || "none"}.`);
  return c;
}

/** Folder of one cadence period in the Houston repo, relative to the repo root. */
export const periodDir = (project: string, cadence: string, period: string) => `projects/${project}/${cadence}/${period}`;
