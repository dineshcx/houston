// The run's draft (.houston-local/draft.md): everything a run wants to publish, as one markdown file
// the person can read, edit, approve or hold. Each section is checked when it's added and again at
// publish, because the person may have edited the file in between. Publishing writes the person's
// own files in the Houston repo and the issue changes, then records the run.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { formatAt, isDate, nextOccurrence, periodOf, zoned } from "./cadence";
import { loadContext, type Context } from "./config";
import { consumeInbox, type InboxBatch } from "./evidence";
import { github, parseRef, refText } from "./github";
import { assertTeamRepo, planLabels, SUMMARY_END, SUMMARY_START, writeLabels, writeSummary } from "./issues";
import { dayLogFile, footer, myProjects, pageFile, stripFooter, writeInRepo } from "./pages";
import { paths } from "./paths";
import { commitAndPush, notReady } from "./repo";
import { hash, readState, updateState, windowStart, type SourceHealth, type State } from "./state";
import { HoustonError, iso, parseDuration } from "./util";

export const SECTION_KINDS = ["day", "page", "summary", "labels", "comment"] as const;
export type Kind = (typeof SECTION_KINDS)[number];
export type Section = { kind: Kind; target: string; body: string };
export type Window = { start: Date; end: Date };
type Draft = NonNullable<State["draft"]>;

const DIRECTIVE = /^<!-- houston:(day|page|summary|labels|comment) (\S+) -->$/;

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

function header(d: Draft, tz: string): string {
  const when = d.deadline ? `publishes ${formatAt(d.deadline, tz)} unless you approve or hold it` : "publishes when you approve it";
  return `<!-- houston draft · window ${formatAt(d.window_start, tz)} → ${formatAt(d.window_end, tz)} · ${when} -->`;
}

/** One label per line; "-label" removes it. */
export function parseLabels(body: string): { add: string[]; remove: string[] } {
  const words = body.split("\n").map((l) => l.replace(/^[-*]\s+/, "").trim()).filter(Boolean);
  return { add: words.filter((w) => !w.startsWith("-")), remove: words.filter((w) => w.startsWith("-")).map((w) => w.slice(1)) };
}

const windowOf = (d: Draft): Window => ({ start: new Date(d.window_start), end: new Date(d.window_end) });

// ---------- checks ----------

/**
 * Checks one section without touching the network, against the draft's window: a day section must
 * be a date inside it, and a page section the cadence period open at its end, never a frozen one.
 */
export function checkSection(s: Section, ctx: Context, window: Window) {
  const { team, cadences, local } = ctx;
  if (!SECTION_KINDS.includes(s.kind)) throw new HoustonError(`"${s.kind}" isn't a draft section. Use one of: ${SECTION_KINDS.join(", ")}.`);
  if (!s.body.trim()) throw new HoustonError(`The ${s.kind} section for ${s.target} is empty.`);
  if (s.body.split("\n").some((l) => DIRECTIVE.test(l.trimEnd()))) throw new HoustonError("A section can't contain another <!-- houston:… --> directive line.");
  const first = zoned(window.start, local.timezone).date;
  const last = zoned(window.end, local.timezone).date;
  switch (s.kind) {
    case "day":
      if (!isDate(s.target)) throw new HoustonError(`"${s.target}" isn't a date. A day section's target is YYYY-MM-DD.`);
      if (s.target < first || s.target > last) throw new HoustonError(`${s.target} isn't in this draft's window (${first === last ? first : `${first} to ${last}`}).`);
      return;
    case "page": {
      const [project, name, period, extra] = s.target.split("/");
      if (!period || extra !== undefined) throw new HoustonError(`"${s.target}" should be <project>/<cadence>/<period>, like storefront/daily/${last}.`);
      const p = team.projects[project];
      if (!p) throw new HoustonError(`There is no project "${project}". Projects: ${Object.keys(team.projects).join(", ")}.`);
      const c = cadences[name];
      if (!c || !p.cadences.includes(name)) throw new HoustonError(`Project ${project} has no cadence "${name}". Its cadences: ${p.cadences.join(", ") || "none"}.`);
      if (!c.writers.includes("runs")) throw new HoustonError(`Runs don't write the ${name} page (its writers are: ${c.writers.join(", ")}).`);
      const open = periodOf(c, last);
      if (period !== open) throw new HoustonError(`${name} period ${period} isn't open; on ${last} the open period is ${open}. Older periods are frozen.`);
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
function problems(sections: Section[], ctx: Context, window: Window): string[] {
  const errors: string[] = [];
  const gh = github();
  for (const s of sections) {
    try {
      checkSection(s, ctx, window);
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

export type DraftStatus = { sections: Section[]; text: string; edited: boolean; held: boolean; deadline?: Date; draft: Draft };

/** The current draft, or undefined when there is none. */
export function draftStatus(): DraftStatus | undefined {
  const d = readState().draft;
  if (!d || !existsSync(paths.draft)) return undefined;
  const text = readFileSync(paths.draft, "utf8");
  return { sections: parseDraft(text), text, edited: !!d.edited || hash(text) !== d.agent_hash, held: !!d.held, deadline: d.deadline ? new Date(d.deadline) : undefined, draft: d };
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

function writeDraft(sections: Section[], d: Draft, tz: string): string {
  const text = renderDraft(sections, header(d, tz));
  mkdirSync(paths.localDir, { recursive: true });
  writeFileSync(paths.draft, text);
  return text;
}

/** Starts a fresh, empty draft for a window, replacing any draft there was. */
export function startDraft(ctx: Context, window: Window, sources: SourceHealth, inbox: InboxBatch[], now = new Date()) {
  const deadline = draftDeadline(ctx, now);
  const draft: Draft = {
    created: iso(now),
    window_start: iso(window.start),
    window_end: iso(window.end),
    ...(deadline ? { deadline: iso(deadline) } : {}),
    agent_hash: "",
    sources,
    inbox,
  };
  draft.agent_hash = hash(writeDraft([], draft, ctx.local.timezone));
  updateState((s) => (s.draft = draft));
}

/**
 * Adds a section, or replaces the one with the same kind and target. `byPerson` is true outside a
 * run: the draft is then marked edited, so the next run waits for the person instead of replacing it.
 */
export function addSection(s: Section, opts: { byPerson: boolean; now?: Date }) {
  const now = opts.now ?? new Date();
  const ctx = loadContext();
  if (!draftStatus()) startDraft(ctx, { start: windowStart(readState(), now), end: now }, {}, [], now);
  const st = draftStatus()!;
  checkSection(s, ctx, windowOf(st.draft));
  const sections = st.sections;
  const i = sections.findIndex((x) => x.kind === s.kind && x.target === s.target);
  if (i >= 0) sections[i] = s;
  else sections.push(s);
  const text = writeDraft(sections, st.draft, ctx.local.timezone);
  updateState((x) => {
    x.draft!.agent_hash = hash(text);
    // Once the person has changed the draft it stays theirs, whoever adds to it next.
    if (opts.byPerson || st.edited) x.draft!.edited = true;
  });
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

/**
 * Publishes the draft. Re-checks it all first; then writes, commits and pushes the person's files,
 * then the summaries and labels, then the comments. If anything throws, the draft stays and
 * publishing again finishes the job: files and labels are idempotent, a failed push is pushed by the
 * next commitAndPush, and comments already posted are recorded so they aren't posted twice.
 */
export function publishDraft(opts: { notReviewed?: boolean; now?: Date } = {}): string[] {
  const now = opts.now ?? new Date();
  const st = draftStatus();
  if (!st) throw new HoustonError("There is no draft to publish. `houston run` makes one.");
  const busy = notReady();
  if (busy) throw new HoustonError(`Not published: ${busy}`);
  const ctx = loadContext();
  const { team, local } = ctx;
  const window = windowOf(st.draft);
  if (!st.sections.length) throw new HoustonError("The draft is empty. Add to it, or throw it away with `houston draft discard`.");
  const errors = problems(st.sections, ctx, window);
  if (errors.length) throw new HoustonError(`The draft can't be published:\n${errors.map((e) => `  - ${e}`).join("\n")}\nFix ${paths.draft} (or \`houston draft discard\`), then run \`houston publish\` again.`);

  const foot = footer(window.end, local.timezone, st.draft.sources, !!opts.notReviewed);
  const done: string[] = [];
  const files: string[] = [];
  for (const s of st.sections) {
    if (s.kind !== "day" && s.kind !== "page") continue;
    const file = s.kind === "day" ? dayLogFile(local.user, s.target) : pageFile(s.target, local.user);
    writeInRepo(file, `${stripFooter(s.body)}\n\n${foot}\n`);
    files.push(file);
    done.push(`wrote ${file.slice(paths.root.length + 1)}`);
  }
  if (files.length) {
    const r = commitAndPush(files, `houston: ${local.user} run ${formatAt(window.end, local.timezone)}`);
    done.push(r.pushed ? "committed and pushed" : `committed: ${r.note ?? "not pushed"}`);
  }

  const gh = github();
  const commented = new Set(st.draft.commented ?? []);
  const order: Kind[] = ["summary", "labels", "comment"];
  for (const s of st.sections.filter((x) => order.includes(x.kind)).sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))) {
    const ref = parseRef(s.target);
    try {
      if (s.kind === "summary") done.push(`${refText(ref)}: ${writeSummary(team, ref, s.body, now).note}`);
      else if (s.kind === "labels") {
        const p = writeLabels(team, ref, parseLabels(s.body).add, parseLabels(s.body).remove);
        done.push(`${refText(ref)}: labels ${[...p.add.map((l) => `+${l}`), ...p.remove.map((l) => `-${l}`)].join(" ") || "unchanged"}`);
      } else if (!commented.has(s.target)) {
        gh.comment(ref, s.body);
        commented.add(s.target);
        updateState((x) => (x.draft!.commented = [...commented]));
        done.push(`${refText(ref)}: commented`);
      }
    } catch (e) {
      throw new HoustonError(`Stopped publishing at ${s.kind} ${refText(ref)}: ${(e as Error).message}\nYour draft is kept. Run \`houston publish\` again; what was already done won't be done twice.`);
    }
  }

  consumeInbox(st.draft.inbox ?? []);
  updateState((s) => {
    s.last_publish = st.draft.window_end;
    s.last_run = { at: iso(now), outcome: "published", sources: st.draft.sources, ...(opts.notReviewed ? { note: "not reviewed" } : {}) };
  });
  discardDraft();
  return done;
}
