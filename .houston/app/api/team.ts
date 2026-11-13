// The team-wide screens: Today (the home screen in one call), People (each member's health in plain
// words), Setup (the team's setup as data, not a CLI dump), Doctor (this laptop's checks) and the
// context every screen starts from.
import { readFileSync } from "node:fs";
import { explain, PERIOD, publishing, rules } from "../../src/commands/explain";
import { problems } from "../../src/commands/validate";
import { addDays } from "../../src/lib/cadence";
import { teamRepos } from "../../src/lib/config";
import { isTrusted, repoCoreVersion } from "../../src/lib/core";
import { draftStatus } from "../../src/lib/draft";
import { dayLogFile, myProjects } from "../../src/lib/pages";
import { houstonRepo } from "../../src/lib/repo";
import { daysInWords } from "../../src/lib/setup";
import { readState } from "../../src/lib/state";
import { parseDuration } from "../../src/lib/util";
import { cached, dayLabel, houston, iso, peek, type Ctx } from "./common";
import { summarize } from "./draft";
import { intakeCount } from "./github";
import { seenMemo, todaysPages, type Footer } from "./pages";

const hhmm = (ctx: Ctx, t: string | Date) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: ctx.local.timezone });

/** "13:05" today, else "Thu 12 Nov 13:05". */
function when(ctx: Ctx, t: string) {
  const date = new Date(t).toLocaleDateString("en-CA", { timeZone: ctx.local.timezone });
  return date === ctx.today ? hhmm(ctx, t) : `${dayLabel(date)} ${hhmm(ctx, t)}`;
}

export type Health = { level: "ok" | "warn" | "bad" | "none"; text: string };

// ---------- people ----------

export function people(ctx: Ctx) {
  const state = readState();
  const yesterday = addDays(ctx.today, -1);
  const seenOf = seenMemo(ctx);
  const pages = todaysPages(ctx);
  return ctx.team.team.members.map((user) => {
    const me = user === ctx.local.user;
    const s = seenOf(user);
    const lastLog = s.dayLogs.at(-1);
    const last = [lastLog, s.newest?.period].filter((d): d is string => !!d).sort().at(-1);
    const footer: Footer | null = lastLog && (!s.newest || lastLog >= s.newest.period) ? s.lastDayLogFooter : (s.newest?.footer ?? s.lastDayLogFooter);
    let health: Health;
    if (me && state.last_run?.outcome === "failed") health = { level: "bad", text: `Last run failed ${when(ctx, state.last_run.at)}${state.last_run.note ? `: ${state.last_run.note}` : ""}` };
    else if (me && state.last_run && Date.now() - Date.parse(state.last_run.at) > 2 * parseDuration(ctx.team.runs.every))
      health = { level: "warn", text: `No run since ${when(ctx, state.last_run.at)}. Check your schedule with \`houston doctor\`.` };
    else if (me && state.last_run) health = { level: "ok", text: `Last run ${when(ctx, state.last_run.at)} · ${state.last_run.outcome}${state.last_run.note ? ` (${state.last_run.note})` : ""}` };
    else if (!last) health = me ? { level: "none", text: "No run on this laptop yet. Run `houston run` or set your schedule." } : { level: "none", text: "Never ran on any laptop" };
    else if (last < yesterday) health = { level: "warn", text: `No run since ${dayLabel(last)}` };
    else if (footer?.problem) health = { level: "warn", text: `Last run couldn't read ${footer.failed.join(", ")}; its update may be missing work` };
    else health = { level: "ok", text: footer ? `Last run ${footer.time}${footer.notReviewed ? " · not reviewed" : " · ok"}` : `Last update ${dayLabel(last)}` };
    const mineToday = pages.filter((p) => p.exists).map((p) => ({ project: p.project, cadence: p.cadence, period: p.period, ...p.updates.find((u) => u.user === user)! }));
    return {
      user,
      me,
      lead: ctx.team.team.leads.includes(user),
      health,
      lastSeen: last ?? null,
      dayLog: lastLog ? { date: lastLog, preview: readFileSync(dayLogFile(user, lastLog), "utf8").slice(0, 1500), footer: s.lastDayLogFooter } : null,
      update: s.newest,
      run: me ? (state.last_run ?? null) : undefined,
      today: mineToday.map(({ project, cadence, period, state, reason }) => ({ project, cadence, period, state, reason })),
      blocked: pages.flatMap((p) => (p.blockedBy[user] ?? []).map((text) => ({ project: p.project, cadence: p.cadence, period: p.period, text }))),
      quiet: health.level !== "ok",
    };
  });
}

// ---------- today ----------

function checklist(ctx: Ctx) {
  const state = readState();
  const found = problems();
  const unlinked = teamRepos(ctx.team).filter((r) => !(r.repo in ctx.local.repos)).map((r) => r.repo);
  const repo = houstonRepo();
  return [
    { id: "valid", label: "Team setup is valid", done: !found.length, detail: found.length ? found.join("\n") : null, command: found.length ? "houston validate" : null },
    { id: "linked", label: "Your repos are linked", done: !unlinked.length, detail: unlinked.length ? `Not linked yet: ${unlinked.join(", ")}` : null, command: unlinked.length ? "houston link" : null },
    { id: "trusted", label: "This laptop trusts the Houston core", done: isTrusted(), detail: null, command: isTrusted() ? null : "houston trust" },
    { id: "schedule", label: "Your schedule is set", done: !!ctx.local.schedule, detail: ctx.local.schedule ?? "Runs start from your scheduler.", command: ctx.local.schedule ? null : "houston schedule" },
    { id: "first-run", label: "First run", done: !!state.last_run, detail: state.last_run ? null : "Run it once now to see your first draft.", command: state.last_run ? null : "houston run" },
    {
      id: "teammates",
      label: "Teammates",
      done: ctx.team.team.members.length > 1,
      detail: ctx.team.team.members.length > 1 ? null : "Only you so far. Send teammates the repo link; they say \"set me up\".",
      command: null,
      link: repo ? `https://github.com/${repo}` : null,
    },
  ];
}

export function today(ctx: Ctx) {
  const state = readState();
  const d = draftStatus();
  const pages = todaysPages(ctx);
  const everyone = people(ctx);
  const deadline = d?.deadline && !d.held ? d.deadline : null;
  const board = peek<{ issues: { issue: { repo: string; number: number; title: string; labels: string[]; assignees: string[] } }[] }>("board");
  const list = checklist(ctx);
  return {
    today: ctx.today,
    todayLabel: dayLabel(ctx.today),
    user: ctx.local.user,
    team: ctx.team.team.name,
    draft: d
      ? {
          status: d.held ? "held" : deadline && deadline < ctx.now ? "overdue" : d.edited ? "edited" : "waiting",
          edited: d.edited,
          held: d.held,
          deadlineAt: d.deadline?.toISOString() ?? null,
          publishesAt: deadline?.toISOString() ?? null,
          summary: summarize(ctx, d.sections),
          sections: d.sections.length,
          failedSources: Object.entries(d.draft.sources).filter(([, h]) => h !== "ok").map(([name, why]) => ({ name, why })),
        }
      : null,
    lastRun: state.last_run ?? null,
    /** About when the next run starts: the last run plus runs.every. */
    nextRunAt: state.last_run ? iso(Date.parse(state.last_run.at) + parseDuration(ctx.team.runs.every)) : null,
    pages: pages.map(({ blockedBy, ...p }) => p),
    /** Open intake PRs; null until the review data is loaded (this call starts loading it). */
    intakePrs: intakeCount(ctx),
    attention: {
      people: everyone.filter((p) => p.health.level === "bad" || p.health.level === "warn" || (p.health.level === "none" && !p.me)).map((p) => ({ user: p.user, me: p.me, health: p.health })),
      /** My issues in the Blocked status, when the board is cached; null when it isn't. */
      myBlocked: board
        ? board.data.issues
            .map((x) => x.issue)
            .filter((i) => i.assignees.includes(ctx.local.user) && i.labels.includes("status:blocked"))
            .map((i) => ({ ref: `${i.repo}#${i.number}`, title: i.title }))
        : null,
    },
    checklist: list,
    checklistDone: list.every((c) => c.done),
  };
}

// ---------- setup and doctor ----------

const PERIOD_NAMES = { day: "Daily", week: "Weekly", sprint: "Sprint", month: "Monthly" };

export function setup(ctx: Ctx) {
  const found = problems();
  const projects = Object.entries(ctx.team.projects).map(([id, p]) => ({
    id,
    name: p.name,
    mine: myProjects(ctx.team, ctx.local).includes(id),
    repos: p.repos.map((r) => ({ repo: r.repo, about: r.about ?? null, linkedAt: ctx.local.repos[r.repo] ?? null })),
    cadences: p.cadences.map((name) => {
      const c = ctx.cadences[name];
      if (!c) return { name, title: name, missing: true };
      return {
        name,
        title: c.title,
        schedule: c.schedule,
        /** "Mon–Fri 09:00" */
        scheduleText: `${daysInWords(c.schedule.days)} ${c.schedule.time}`,
        period: c.period,
        periodName: PERIOD_NAMES[c.period],
        periodText: PERIOD[c.period](c),
        writers: c.writers,
      };
    }),
  }));
  return {
    team: ctx.team.team,
    repo: houstonRepo() ?? null,
    core: { version: repoCoreVersion(), wanted: ctx.team.core },
    projects,
    statuses: ctx.team.status.columns,
    priority: ctx.team.priority,
    rules: { values: ctx.team.rules, sentences: rules(ctx.team.rules) },
    publishing: publishing(ctx.team),
    runs: ctx.team.runs,
    validation: { ok: !found.length, problems: found },
    you: { user: ctx.local.user, timezone: ctx.local.timezone, schedule: ctx.local.schedule ?? null, trusted: isTrusted() },
    // The plain-text versions, for a "Plain text" toggle (and the old screen).
    explain: { ok: true, output: explain(ctx.team, ctx.cadences) },
    validate: { ok: !found.length, output: found.length ? `✗ ${found.length} file(s) need fixing:\n\n${found.join("\n\n")}` : "✓ houston.yml and cadences/ are valid." },
  };
}

/** `houston doctor`'s checks as data. It asks GitHub who you are once; cached a minute. */
export async function doctor(refresh: boolean) {
  const { at, data } = await cached("doctor", refresh, async () => {
    const r = await houston(["doctor"]);
    const checks: { mark: "ok" | "fail" | "warn"; text: string; fix: string | null }[] = [];
    for (const line of r.output.split("\n")) {
      const m = /^([✓✗!]) (.*)$/.exec(line);
      if (!m) {
        if (checks.length && line.trim()) checks.at(-1)!.text += `\n${line.trim()}`;
        continue;
      }
      const [text, fix] = m[2].split(" — ");
      checks.push({ mark: ({ "✓": "ok", "✗": "fail", "!": "warn" } as const)[m[1] as "✓"], text, fix: fix ?? null });
    }
    return { ok: r.ok, checks, output: r.output };
  });
  return { ...data, fetchedAt: iso(at) };
}

/** What every screen starts from: who you are, the team, its projects and cadences. */
export function about(ctx: Ctx) {
  const state = readState();
  return {
    team: ctx.team.team.name,
    user: ctx.local.user,
    timezone: ctx.local.timezone,
    today: ctx.today,
    repo: houstonRepo() ?? null,
    members: ctx.team.team.members,
    leads: ctx.team.team.leads,
    mine: myProjects(ctx.team, ctx.local),
    projects: Object.fromEntries(
      Object.entries(ctx.team.projects).map(([id, p]) => [id, { name: p.name, repos: p.repos.map((r) => r.repo), cadences: p.cadences.filter((c) => ctx.cadences[c]).map((c) => ({ name: c, title: ctx.cadences[c].title, period: ctx.cadences[c].period })) }]),
    ),
    columns: ctx.team.status.columns,
    priority: ctx.team.priority,
    lastRun: state.last_run ?? null,
    runsEveryMs: parseDuration(ctx.team.runs.every),
    hasDraft: !!draftStatus(),
  };
}

