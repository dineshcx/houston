// The run's draft (.houston-local/draft.md): everything a run wants to publish, as one markdown file
// the person can read, edit, approve or hold. Each section is checked when it's added and again at
// publish, because the person may have edited the file in between. Publishing writes the person's
// own files in the Houston repo and the issue changes, then records the run.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadCadences, nextOccurrence, periodDir, periodOf, renderPage, zoned, type Cadence } from "./cadence";
import { loadLocal, loadTeam, type Local, type Team } from "./config";
import { consumeInbox, type InboxBatch } from "./evidence";
import { github, parseRef, refText } from "./github";
import { assertTeamRepo, planLabels, SUMMARY_END, SUMMARY_START, writeLabels, writeSummary } from "./issues";
import { paths } from "./paths";
import { commitAndPush } from "./repo";
import { hash, readState, updateState, type SourceHealth, type State } from "./state";
import { HoustonError, iso, parseDuration } from "./util";

export const KINDS = ["day", "page", "summary", "labels", "comment"] as const;
export type Kind = (typeof KINDS)[number];
export type Section = { kind: Kind; target: string; body: string };

const DIRECTIVE = /^<!-- houston:(day|page|summary|labels|comment) (\S+) -->$/;
const FOOTER = /^_run \d{2}:\d{2} · .*_$/;

/** agent_hash when the person has edited the draft: no file ever hashes to it. */
const EDITED = "";

export type Context = { team: Team; cadences: Record<string, Cadence>; local: Local };

export function loadContext(): Context {
  const cadences = loadCadences();
  return { team: loadTeam(paths.team, Object.keys(cadences)), cadences, local: loadLocal() };
}

// ---------- the file format ----------

export function parseDraft(text: string): Section[] {
  const out: (Section & { lines: string[] })[] = [];
  for (const line of text.split("\n")) {
    const m = DIRECTIVE.exec(line.trimEnd());
    if (m) out.push({ kind: m[1] as Kind, target: m[2], body: "", lines: [] });
    else out.at(-1)?.lines.push(line);
  }
  return out.map(({ kind, target, lines }) => ({ kind, target, body: lines.join("\n").trim() }));
}

export function renderDraft(sections: Section[], header: string): string {
  return [header, ...sections.map((s) => `<!-- houston:${s.kind} ${s.target} -->\n${s.body.trim()}\n`)].join("\n\n").trimEnd() + "\n";
}

function header(d: NonNullable<State["draft"]>, tz: string): string {
  const at = (s: string) => {
    const z = zoned(new Date(s), tz);
    return `${z.date} ${z.time}`;
  };
  const when = d.deadline ? `publishes ${at(d.deadline)} unless you approve or hold it` : "publishes when you approve it";
  return `<!-- houston draft · window ${at(d.window_start)} → ${at(d.window_end)} · ${when} -->`;
}

/** One label per line; "-label" removes it. */
export function parseLabels(body: string): { add: string[]; remove: string[] } {
  const words = body.split("\n").map((l) => l.replace(/^[-*]\s+/, "").trim()).filter(Boolean);
  return { add: words.filter((w) => !w.startsWith("-")), remove: words.filter((w) => w.startsWith("-")).map((w) => w.slice(1)) };
}

// ---------- checks ----------

/**
 * Checks one section without touching the network. `date` is the person's date the draft is about:
 * a page section must be for the cadence period open on that date, never a frozen one.
 */
export function checkSection(s: Section, ctx: Context, date: string) {
  const { team, cadences } = ctx;
  if (!KINDS.includes(s.kind)) throw new HoustonError(`"${s.kind}" isn't a draft section. Use one of: ${KINDS.join(", ")}.`);
  if (!s.body.trim()) throw new HoustonError(`The ${s.kind} section for ${s.target} is empty.`);
  if (s.body.split("\n").some((l) => DIRECTIVE.test(l.trimEnd()))) throw new HoustonError("A section can't contain another <!-- houston:… --> directive line.");
  switch (s.kind) {
    case "day":
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s.target) || isNaN(Date.parse(s.target)) || new Date(s.target).toISOString().slice(0, 10) !== s.target)
        throw new HoustonError(`"${s.target}" isn't a date. A day section's target is YYYY-MM-DD.`);
      return;
    case "page": {
      const [project, name, period, extra] = s.target.split("/");
      if (!period || extra !== undefined) throw new HoustonError(`"${s.target}" should be <project>/<cadence>/<period>, like storefront/daily/${date}.`);
      const p = team.projects[project];
      if (!p) throw new HoustonError(`There is no project "${project}". Projects: ${Object.keys(team.projects).join(", ")}.`);
      const c = cadences[name];
      if (!c || !p.cadences.includes(name)) throw new HoustonError(`Project ${project} has no cadence "${name}". Its cadences: ${p.cadences.join(", ") || "none"}.`);
      if (!c.writers.includes("runs")) throw new HoustonError(`Runs don't write the ${name} page (its writers are: ${c.writers.join(", ")}).`);
      const open = periodOf(c, date);
      if (period !== open) throw new HoustonError(`${name} period ${period} isn't open; on ${date} the open period is ${open}. Older periods are frozen.`);
      return;
    }
    case "summary":
      assertTeamRepo(team, parseRef(s.target).repo);
      if (s.body.includes(SUMMARY_START) || s.body.includes(SUMMARY_END)) throw new HoustonError("Write the summary without the houston:summary markers; Houston adds them.");
      return;
    case "labels": {
      assertTeamRepo(team, parseRef(s.target).repo);
      const { add, remove } = parseLabels(s.body);
      planLabels(team, [], add, remove);
      return;
    }
    case "comment":
      assertTeamRepo(team, parseRef(s.target).repo);
      if (team.rules.issue_comment === "none") throw new HoustonError("The team's rules say runs don't comment on issues (rules.issue_comment: none).");
      return;
  }
}

/** Checks a whole draft, the issue sections against GitHub too. Returns every problem found. */
function problems(sections: Section[], ctx: Context, date: string): string[] {
  const errors: string[] = [];
  const gh = github();
  for (const s of sections) {
    try {
      checkSection(s, ctx, date);
      if (s.kind === "summary" || s.kind === "labels" || s.kind === "comment") {
        const issue = gh.issue(parseRef(s.target));
        if (s.kind === "labels") planLabels(ctx.team, issue.labels, parseLabels(s.body).add, parseLabels(s.body).remove);
      }
    } catch (e) {
      if (!(e instanceof HoustonError)) throw e;
      errors.push(`${s.kind} ${s.target}: ${e.message}`);
    }
  }
  return errors;
}

// ---------- the draft on disk ----------

export type DraftStatus = { sections: Section[]; text: string; edited: boolean; held: boolean; deadline?: Date; draft: NonNullable<State["draft"]> };

/** The current draft, or undefined when there is none. */
export function draftStatus(): DraftStatus | undefined {
  const d = readState().draft;
  if (!d || !existsSync(paths.draft)) return undefined;
  const text = readFileSync(paths.draft, "utf8");
  return { sections: parseDraft(text), text, edited: hash(text) !== d.agent_hash, held: !!d.held, deadline: d.deadline ? new Date(d.deadline) : undefined, draft: d };
}

/** Projects this person works in: those with a repo in their houston.local.yml (all, if none). */
export function myProjects(team: Team, local: Local): string[] {
  const mine = new Set(Object.keys(local.repos).map((r) => r.toLowerCase()));
  const ids = Object.keys(team.projects).filter((id) => team.projects[id].repos.some((r) => mine.has(r.repo.toLowerCase())));
  return ids.length ? ids : Object.keys(team.projects);
}

/**
 * When a draft publishes on its own: `publish_deadline` before the person's next cadence time, if
 * that's within a day; otherwise one run interval after it was made. Only for review_until_deadline.
 */
export function draftDeadline(ctx: Context, created: Date): Date | undefined {
  const { team, cadences, local } = ctx;
  if (team.rules.publish_runs !== "review_until_deadline") return undefined;
  const next = myProjects(team, local)
    .flatMap((p) => team.projects[p].cadences)
    .map((name) => cadences[name])
    .filter((c) => c?.writers.includes("runs"))
    .map((c) => nextOccurrence(c.schedule, created, local.timezone)?.getTime())
    .filter((t): t is number => t !== undefined);
  const first = next.length ? Math.min(...next) : undefined;
  if (first !== undefined && first - created.getTime() <= 86_400_000) return new Date(first - parseDuration(team.rules.publish_deadline));
  return new Date(created.getTime() + parseDuration(team.runs.every));
}

/** Starts a fresh, empty draft for a window, replacing any draft there was. */
export function startDraft(ctx: Context, window: { start: Date; end: Date }, sources: SourceHealth, inbox: InboxBatch[], now = new Date()) {
  const deadline = draftDeadline(ctx, now);
  const draft: NonNullable<State["draft"]> = {
    created: iso(now),
    window_start: iso(window.start),
    window_end: iso(window.end),
    ...(deadline ? { deadline: iso(deadline) } : {}),
    agent_hash: "",
    sources,
    inbox,
  };
  const text = renderDraft([], header(draft, ctx.local.timezone));
  draft.agent_hash = hash(text);
  mkdirSync(paths.localDir, { recursive: true });
  writeFileSync(paths.draft, text);
  updateState((s) => (s.draft = draft));
}

/** Adds a section, or replaces the one with the same kind and target. */
export function addSection(s: Section, now = new Date()) {
  const ctx = loadContext();
  if (!draftStatus()) {
    const last = readState().last_publish;
    startDraft(ctx, { start: last ? new Date(last) : new Date(now.getTime() - 86_400_000), end: now }, {}, [], now);
  }
  const st = draftStatus()!;
  checkSection(s, ctx, zoned(new Date(st.draft.window_end), ctx.local.timezone).date);
  const sections = st.sections;
  const i = sections.findIndex((x) => x.kind === s.kind && x.target === s.target);
  if (i >= 0) sections[i] = s;
  else sections.push(s);
  const text = renderDraft(sections, header(st.draft, ctx.local.timezone));
  writeFileSync(paths.draft, text);
  // Once the person has edited the draft it stays marked as theirs, so no run replaces it.
  updateState((x) => (x.draft!.agent_hash = st.edited ? EDITED : hash(text)));
}

export function setHeld(held: boolean) {
  if (!draftStatus()) throw new HoustonError("There is no draft right now.");
  updateState((s) => (s.draft!.held = held || undefined));
}

/** Throws the draft away. The next run covers the same window again. */
export function discardDraft() {
  rmSync(paths.draft, { force: true });
  updateState((s) => delete s.draft);
}

// ---------- publishing ----------

export const dayLogFile = (user: string, date: string) => join(paths.people, user, `${date}.md`);
export const pageFile = (target: string, user: string) => {
  const [project, cadence, period] = target.split("/");
  return join(paths.root, periodDir(project, cadence, period), `${user}.md`);
};

/** A file's content without the run footer, so a merged rewrite doesn't stack old footers. */
export const stripFooter = (text: string) => text.split("\n").filter((l) => !FOOTER.test(l.trim())).join("\n").trim();

export function footer(at: Date, tz: string, sources: SourceHealth, notReviewed: boolean): string {
  const health = Object.entries(sources).map(([k, v]) => `${k} ${v === "ok" ? "ok" : "failed"}`);
  return `_${[`run ${zoned(at, tz).time}`, ...(health.length ? [`sources: ${health.join(", ")}`] : []), ...(notReviewed ? ["not reviewed"] : [])].join(" · ")}_`;
}

/**
 * Publishes the draft. Re-checks it all first; writes the person's files, then the issue changes,
 * then commits and pushes. If anything throws, the draft stays and nothing is recorded: every
 * write is idempotent, so publishing again redoes it. Returns one line per thing done.
 */
export function publishDraft(opts: { notReviewed?: boolean; now?: Date } = {}): string[] {
  const now = opts.now ?? new Date();
  const st = draftStatus();
  if (!st) throw new HoustonError("There is no draft to publish. `houston run` makes one.");
  const ctx = loadContext();
  const { team, local } = ctx;
  const end = new Date(st.draft.window_end);
  const date = zoned(end, local.timezone).date;
  if (!st.sections.length) throw new HoustonError("The draft is empty. Add to it, or throw it away with `houston draft discard`.");
  const errors = problems(st.sections, ctx, date);
  if (errors.length) throw new HoustonError(`The draft can't be published:\n${errors.map((e) => `  - ${e}`).join("\n")}\nFix ${paths.draft} (or \`houston draft discard\`), then run \`houston publish\` again.`);

  const foot = footer(end, local.timezone, st.draft.sources, !!opts.notReviewed);
  const done: string[] = [];
  const files: string[] = [];
  for (const s of st.sections) {
    if (s.kind !== "day" && s.kind !== "page") continue;
    const file = s.kind === "day" ? dayLogFile(local.user, s.target) : pageFile(s.target, local.user);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${stripFooter(s.body)}\n\n${foot}\n`);
    files.push(file);
    done.push(`wrote ${file.slice(paths.root.length + 1)}`);
  }

  const gh = github();
  // ponytail: a comment isn't idempotent; if a later write fails, publishing again repeats it. Comments go last to keep that rare.
  const order = ["summary", "labels", "comment"];
  for (const s of st.sections.filter((x) => order.includes(x.kind)).sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))) {
    const ref = parseRef(s.target);
    try {
      if (s.kind === "summary") done.push(`${refText(ref)}: ${writeSummary(team, ref, s.body, now).note}`);
      else if (s.kind === "labels") {
        const p = writeLabels(team, ref, parseLabels(s.body).add, parseLabels(s.body).remove);
        done.push(`${refText(ref)}: labels ${[...p.add.map((l) => `+${l}`), ...p.remove.map((l) => `-${l}`)].join(" ") || "unchanged"}`);
      } else {
        gh.comment(ref, s.body);
        done.push(`${refText(ref)}: commented`);
      }
    } catch (e) {
      throw new HoustonError(`Stopped publishing at ${s.kind} ${refText(ref)}: ${(e as Error).message}\nYour draft is kept. Run \`houston publish\` again; what was already done won't be done twice.`);
    }
  }

  if (files.length) {
    const z = zoned(end, local.timezone);
    const r = commitAndPush(files, `houston: ${local.user} run ${z.date} ${z.time}`);
    done.push(r.pushed ? "committed and pushed" : `committed: ${r.note ?? "not pushed"}`);
  }
  consumeInbox(st.draft.inbox ?? []);
  updateState((s) => {
    s.last_publish = st.draft.window_end;
    s.last_run = { at: iso(now), outcome: "published", sources: st.draft.sources, ...(opts.notReviewed ? { note: "not reviewed" } : {}) };
  });
  discardDraft();
  return done;
}

// ---------- cadence pages ----------

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
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderPage(c, { period, project }));
  return file;
}
