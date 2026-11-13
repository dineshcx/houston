// My draft, for the review screen: each section with where it goes in words, label changes as
// from → to, summaries next to the current one, and when it publishes. Editing one section rewrites
// only that section's lines (spliceSection), so every marker and every other section stays byte for
// byte; the raw file can still be saved whole. Publish, hold, release and discard go through the CLI.
import { writeFileSync } from "node:fs";
import { formatAt } from "../../src/lib/cadence";
import { PRIORITIES } from "../../src/lib/config";
import { checkSection, draftStatus, parseLabels, spliceSection, type Section } from "../../src/lib/draft";
import { paths } from "../../src/lib/paths";
import { hash } from "../../src/lib/state";
import { HoustonError } from "../../src/lib/util";
import { context, dayLabel, forget, HttpError, mustHouston, serial, type Ctx } from "./common";
import { readSummary } from "../../src/lib/issues";
import { findIssues, toCard, type Card } from "./github";

const KIND_NAMES: Record<string, string> = { page: "Your update", day: "Your day log", summary: "Living summary", labels: "Issue changes", comment: "Comment" };

type Change = { field: "status" | "priority" | "kind" | "label"; from: string | null; to: string | null; fromName: string | null; toName: string | null };

/** A labels section as from → to changes, against the issue's current labels when known. */
function labelChanges(ctx: Ctx, body: string, issue: Card | null): Change[] {
  const { add, remove } = parseLabels(body);
  const current = issue ? [issue.status && `status:${issue.status}`, issue.priority, issue.kind && `kind:${issue.kind}`].filter((x): x is string => !!x) : [];
  const fieldOf = (l: string): Change["field"] => (l.startsWith("status:") ? "status" : PRIORITIES.includes(l as any) ? "priority" : l.startsWith("kind:") ? "kind" : "label");
  const value = (l: string) => l.replace(/^(status|kind):/, "");
  const name = (field: Change["field"], v: string | null) => {
    if (!v) return null;
    if (field === "status") return ctx.team.status.columns.find((c) => c.label === v)?.name ?? v;
    if (field === "priority") return ctx.team.priority[v as keyof typeof ctx.team.priority] ?? v;
    return v;
  };
  const out: Change[] = [];
  for (const l of add) {
    const field = fieldOf(l);
    const was = current.find((c) => fieldOf(c) === field && field !== "label");
    const from = was ? value(was) : null;
    out.push({ field, from, to: value(l), fromName: name(field, from), toName: name(field, value(l)) });
  }
  for (const l of remove) if (!add.some((a) => fieldOf(a) === fieldOf(l) && fieldOf(l) !== "label")) out.push({ field: fieldOf(l), from: value(l), to: null, fromName: name(fieldOf(l), value(l)), toName: null });
  return out;
}

/** Where a section goes, in words: "Your update · Storefront · Daily standup · Fri 13 Nov". */
function describe(ctx: Ctx, s: Section, issue: Card | null) {
  if (s.kind === "page") {
    const [project, cadence, period] = s.target.split("/");
    const projectName = ctx.team.projects[project]?.name ?? project;
    const cadenceTitle = ctx.cadences[cadence]?.title ?? cadence;
    return { label: `${KIND_NAMES.page} · ${projectName} · ${cadenceTitle} · ${dayLabel(period)}`, destination: { project, projectName, cadence, cadenceTitle, period } };
  }
  if (s.kind === "day") return { label: `${KIND_NAMES.day} · ${dayLabel(s.target)}` };
  const ident = issue ? `${issue.ident} ${issue.title}` : s.target;
  return { label: `${KIND_NAMES[s.kind]} · ${ident}` };
}

/** "Update for Storefront · Daily standup, day log, 2 issue summaries, 1 label change" */
export function summarize(ctx: Ctx, sections: Section[]): string {
  const n = (k: string) => sections.filter((s) => s.kind === k).length;
  const plural = (count: number, one: string) => (count === 1 ? `1 ${one}` : `${count} ${one}s`);
  const pages = sections.filter((s) => s.kind === "page").map((s) => {
    const [p, c] = s.target.split("/");
    return `${ctx.team.projects[p]?.name ?? p} · ${ctx.cadences[c]?.title ?? c}`;
  });
  return [
    // Past two pages a list stops being readable: "Updates for 6 pages" (the cards below name them).
    pages.length > 2 ? `Updates for ${pages.length} pages` : pages.length ? `Update for ${pages.join(" and ")}` : "",
    n("day") ? "day log" : "",
    n("summary") ? plural(n("summary"), "issue summary").replace("summarys", "summaries") : "",
    n("labels") ? plural(n("labels"), "label change") : "",
    n("comment") ? plural(n("comment"), "comment") : "",
  ]
    .filter(Boolean)
    .join(", ");
}

export async function readDraft(ctx: Ctx) {
  const d = draftStatus();
  if (!d) return { exists: false as const };
  const refs = d.sections.filter((s) => s.kind !== "page" && s.kind !== "day").map((s) => s.target);
  const { found, fetchedAt } = refs.length ? await findIssues(ctx, refs) : { found: {} as Awaited<ReturnType<typeof findIssues>>["found"], fetchedAt: null };
  const sections = d.sections.map((s, index) => {
    const f = found[s.target] ?? null;
    const issue = f ? toCard(ctx.team, f.issue, f.project) : null;
    let problem: string | null = null;
    try {
      checkSection(s, ctx, { start: new Date(d.draft.window_start), end: new Date(d.draft.window_end) });
    } catch (e) {
      if (!(e instanceof HoustonError)) throw e;
      problem = e.message;
    }
    return {
      index,
      kind: s.kind,
      target: s.target,
      body: s.body,
      lines: s.body.split("\n").filter((l) => l.trim()).length,
      ...describe(ctx, s, issue),
      ...(s.kind === "summary" || s.kind === "labels" || s.kind === "comment" ? { issue } : {}),
      ...(s.kind === "labels" ? { changes: labelChanges(ctx, s.body, issue) } : {}),
      /** The issue's living summary now, to diff against the new one. */
      ...(s.kind === "summary" ? { currentSummary: f ? (readSummary(f.issue.body) ?? null) : null } : {}),
      /** Why publishing would refuse this section, checked without the network. */
      problem,
    };
  });
  const deadline = d.deadline && !d.held ? d.deadline : null;
  return {
    exists: true as const,
    text: d.text,
    /** Send back with edits, so an edit can't overwrite a run that changed the draft meanwhile. */
    hash: hash(d.text),
    edited: d.edited,
    held: d.held,
    mode: ctx.team.rules.publish_runs,
    deadline: d.deadline ? formatAt(d.deadline, ctx.local.timezone) : null,
    deadlineAt: d.deadline?.toISOString() ?? null,
    /** When it will publish on its own: null when held or there's no deadline. */
    publishesAt: deadline?.toISOString() ?? null,
    overdue: !!deadline && deadline < ctx.now,
    created: formatAt(d.draft.created, ctx.local.timezone),
    createdAt: d.draft.created,
    window: `${formatAt(d.draft.window_start, ctx.local.timezone)} to ${formatAt(d.draft.window_end, ctx.local.timezone)}`,
    windowStart: d.draft.window_start,
    windowEnd: d.draft.window_end,
    sources: d.draft.sources,
    failedSources: Object.entries(d.draft.sources).filter(([, h]) => h !== "ok").map(([name, h]) => ({ name, why: h })),
    summary: summarize(ctx, d.sections),
    counts: Object.fromEntries(["page", "day", "summary", "labels", "comment"].map((k) => [k, d.sections.filter((s) => s.kind === k).length])),
    issuesFetchedAt: fetchedAt,
    sections,
  };
}

function current(expectHash: unknown) {
  const d = draftStatus();
  if (!d) throw new HttpError(404, "There's no draft right now. Your next run makes one.");
  if (expectHash !== undefined && expectHash !== hash(d.text)) throw new HttpError(409, "Your draft changed since you opened it (a run or another window). Reload it and make your change again.");
  return d;
}

/** Rewrites one section's body; everything else in the file stays as it was. */
export async function editSection(index: number, body: { body?: unknown; hash?: unknown; kind?: unknown; target?: unknown }) {
  if (typeof body.body !== "string") throw new HttpError(400, 'Send the section as { body: "…", hash: "…" }.');
  const ctx = context();
  const d = current(body.hash);
  const s = d.sections[index];
  if (!s) throw new HttpError(404, `Your draft has no section ${index + 1}.`);
  if ((body.kind !== undefined && body.kind !== s.kind) || (body.target !== undefined && body.target !== s.target))
    throw new HttpError(409, "The draft's sections changed since you opened it. Reload it and make your change again.");
  checkSection({ ...s, body: body.body.trim() }, ctx, { start: new Date(d.draft.window_start), end: new Date(d.draft.window_end) });
  // A direct edit: draftStatus sees the changed hash and marks the draft edited.
  writeFileSync(paths.draft, spliceSection(d.text, index, body.body));
  return readDraft(ctx);
}

export async function removeSection(index: number, body: { hash?: unknown }) {
  const d = current(body.hash);
  if (!d.sections[index]) throw new HttpError(404, `Your draft has no section ${index + 1}.`);
  writeFileSync(paths.draft, spliceSection(d.text, index, null));
  return readDraft(context());
}

/** The "Edit raw" escape hatch: the whole file as the person wrote it. */
export async function saveRaw(text: unknown, expectHash: unknown) {
  if (typeof text !== "string") throw new HttpError(400, 'Send the draft as { text: "…" }.');
  current(expectHash);
  writeFileSync(paths.draft, text);
  return readDraft(context());
}

const ACTIONS: Record<string, string[]> = { publish: ["publish"], hold: ["draft", "hold"], release: ["draft", "release"], discard: ["draft", "discard"] };

export async function draftAction(action: string) {
  if (!ACTIONS[action]) throw new HttpError(404, `"${action}" is not something you can do to a draft.`);
  const before = draftStatus();
  const output = await serial(() => mustHouston(ACTIONS[action]));
  // Publishing changes summaries and labels on GitHub, so the cached copies are out of date.
  if (action === "publish") ["board", "issue"].forEach(forget);
  const ctx = context();
  const published =
    action === "publish" && before
      ? {
          at: ctx.now.toISOString(),
          pages: before.sections.filter((s) => s.kind === "page").map((s) => {
            const [project, cadence, period] = s.target.split("/");
            return { project, cadence, period, label: describe(ctx, s, null).label };
          }),
        }
      : null;
  return { output, published, ...(await readDraft(ctx)) };
}
