// GitHub-backed screens: the board, issue chips (a cheap lookup from the cached board), one
// issue's detail, moving an issue's status, and intake review. Reads run on a worker and are cached
// for a minute (fetchedAt says when); writes go through the houston CLI.
import { PRIORITIES, STATUSES, teamRepos, type Team } from "../../src/lib/config";
import { refText, type Issue, type IssueRef } from "../../src/lib/github";
import { ISSUE_KINDS, assertTeamRepo, readSummary, withoutSummary } from "../../src/lib/issues";
import { houstonRepo } from "../../src/lib/repo";
import { cached, forget, HttpError, inWorker, iso, mustHouston, patch, peek, serial, type Ctx } from "./common";

export function refFrom(ctx: Ctx, owner: string, repo: string, number: string): IssueRef {
  if (!/^\d+$/.test(number)) throw new HttpError(400, `"${number}" is not an issue number.`);
  const ref = { repo: `${owner}/${repo}`, number: Number(number) };
  assertTeamRepo(ctx.team, ref.repo);
  return ref;
}

// ---------- cards and chips ----------

/** The team column an issue sits in: its status label, if the team shows that status; else null ("No status"). */
const columnOf = (team: Team, labels: string[]) => team.status.columns.find((c) => labels.includes(`status:${c.label}`))?.label ?? null;

const statusName = (team: Team, status: string | null) => (status ? (team.status.columns.find((c) => c.label === status)?.name ?? status) : null);

export function toCard(team: Team, i: Issue, project: string | null) {
  const status = i.labels.find((l) => l.startsWith("status:"))?.slice("status:".length) ?? null;
  const priority = PRIORITIES.find((p) => i.labels.includes(p)) ?? null;
  const kind = ISSUE_KINDS.find((k) => i.labels.includes(`kind:${k}`)) ?? null;
  return {
    ref: refText(i),
    /** "web#12": the repo without its owner, for compact display. */
    ident: `${i.repo.split("/")[1]}#${i.number}`,
    repo: i.repo,
    number: i.number,
    project,
    title: i.title,
    url: i.url,
    state: i.state,
    assignees: i.assignees,
    status,
    statusName: statusName(team, status),
    column: columnOf(team, i.labels),
    priority,
    priorityName: priority ? team.priority[priority] : null,
    kind,
    /** Labels Houston doesn't manage, shown as plain chips. */
    labels: i.labels.filter((l) => !l.startsWith("status:") && !PRIORITIES.includes(l as any) && !l.startsWith("kind:")),
    hasSummary: readSummary(i.body) !== undefined,
    updatedAt: i.updatedAt,
  };
}
export type Card = ReturnType<typeof toCard>;

type BoardData = { issues: { issue: Issue; project: string }[]; errors: string[] };
const loadBoard = (ctx: Ctx, refresh: boolean) => cached<BoardData>("board", refresh, () => inWorker("board", ctx.team));

export async function board(ctx: Ctx, refresh: boolean) {
  const { at, data } = await loadBoard(ctx, refresh);
  const cards = data.issues.map((i) => toCard(ctx.team, i.issue, i.project));
  return {
    fetchedAt: iso(at),
    errors: data.errors,
    columns: [...ctx.team.status.columns, { label: null, name: "No status" }].map((c) => ({ ...c, cards: cards.filter((card) => card.column === c.label) })),
  };
}

const projectOfRepo = (team: Team, repo: string) => teamRepos(team).find((r) => r.repo.toLowerCase() === repo.toLowerCase())?.project ?? null;

/**
 * The issues behind these refs: from the cached board when it has them (loading it if it isn't
 * cached), else one fetch per missing issue (closed ones, say), cached a minute too. Refs outside
 * the team's repos, or that can't be read, come back null.
 */
export async function findIssues(ctx: Ctx, refs: string[]) {
  const wanted = [...new Set(refs.map((r) => r.trim()).filter(Boolean))].slice(0, 100);
  const found: Record<string, { issue: Issue; project: string | null } | null> = {};
  const errors: Record<string, string> = {};
  const parsed = wanted.map((text) => ({ text, m: /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(text) }));
  const ours = parsed.filter((p) => p.m && projectOfRepo(ctx.team, p.m[1]) !== null);
  for (const p of parsed) if (!ours.includes(p)) found[p.text] = null;
  let fetchedAt = Date.now();
  if (ours.length) {
    const b = peek<BoardData>("board") ?? (await loadBoard(ctx, false).catch(() => undefined));
    if (b) fetchedAt = b.at;
    const byRef = new Map((b?.data.issues ?? []).map((i) => [refText(i.issue).toLowerCase(), i]));
    await Promise.all(
      ours.map(async ({ text, m }) => {
        const hit = byRef.get(text.toLowerCase());
        if (hit) return void (found[text] = hit);
        try {
          const ref = { repo: m![1], number: Number(m![2]) };
          const { at, data } = await cached<Issue>(`issue:${text.toLowerCase()}`, false, () => inWorker("issue", ref));
          fetchedAt = Math.min(fetchedAt, at);
          found[text] = { issue: data, project: projectOfRepo(ctx.team, ref.repo) };
        } catch (e) {
          found[text] = null;
          errors[text] = (e as Error).message;
        }
      }),
    );
  }
  return { fetchedAt: iso(fetchedAt), found, errors };
}

/** Chips for these refs: title, state, status, assignees and more (see Card). */
export async function lookupIssues(ctx: Ctx, refs: string[]) {
  const { fetchedAt, found, errors } = await findIssues(ctx, refs);
  const issues = Object.fromEntries(Object.entries(found).map(([ref, f]) => [ref, f ? toCard(ctx.team, f.issue, f.project) : null]));
  return { fetchedAt, issues, errors };
}

export async function issueDetail(ctx: Ctx, ref: IssueRef, refresh: boolean, withComments: boolean) {
  const key = `issue:${refText(ref).toLowerCase()}`;
  const [{ at, data: i }, comments] = await Promise.all([
    cached<Issue>(key, refresh, () => inWorker("issue", ref)),
    withComments ? inWorker<{ author: string; body: string; createdAt: string | null }[]>("comments", ref) : Promise.resolve(undefined),
  ]);
  return {
    ...toCard(ctx.team, i, projectOfRepo(ctx.team, i.repo)),
    fetchedAt: iso(at),
    allLabels: i.labels,
    summary: readSummary(i.body) ?? null,
    body: withoutSummary(i.body),
    ...(comments ? { comments } : {}),
  };
}

export async function setStatus(ctx: Ctx, ref: IssueRef, status: unknown) {
  if (!STATUSES.includes(status as (typeof STATUSES)[number])) throw new HttpError(400, `"${status}" is not a status. Use one of: ${STATUSES.join(", ")}.`);
  const output = await serial(() => mustHouston(["labels", refText(ref), `status:${status}`]));
  // Patch the cached copies instead of refetching the whole board.
  const move = (i: Issue) => {
    if (refText(i).toLowerCase() !== refText(ref).toLowerCase()) return;
    i.labels = [...i.labels.filter((l) => !l.startsWith("status:")), `status:${status}`];
  };
  patch<BoardData>("board", (b) => b.issues.forEach((x) => move(x.issue)));
  forget(`issue:${refText(ref).toLowerCase()}`);
  const hit = peek<BoardData>("board")?.data.issues.find((x) => refText(x.issue).toLowerCase() === refText(ref).toLowerCase());
  return { output, card: hit ? toCard(ctx.team, hit.issue, hit.project) : null };
}

// ---------- intake review ----------

type ReviewData = { repo: string | null; prs: any[] };

export async function review(ctx: Ctx, refresh: boolean) {
  if (!houstonRepo()) return { repo: null, prs: [], fetchedAt: null };
  const { at, data } = await cached<ReviewData>("review", refresh, () => inWorker("review", ctx.team));
  return { ...data, fetchedAt: iso(at) };
}

/** The number of open intake PRs if review data is cached; otherwise starts loading it and says null. */
export function intakeCount(ctx: Ctx): number | null {
  const hit = peek<ReviewData>("review");
  if (hit) return hit.data.prs.length;
  if (houstonRepo()) review(ctx, false).catch(() => {});
  return null;
}

export async function merge(number: string) {
  const repo = houstonRepo();
  if (!repo) throw new HttpError(409, "This Houston repo has no GitHub origin, so there is nothing to merge.");
  if (!/^\d+$/.test(number)) throw new HttpError(400, `"${number}" is not a pull request number.`);
  await serial(() => inWorker("merge", repo, Number(number)));
  forget("review");
  return { merged: true };
}
