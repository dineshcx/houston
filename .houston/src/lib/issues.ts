// Every change Houston makes to an issue goes through here, so the team's rules are enforced by
// code rather than by asking an agent nicely: only the team's repos, only core labels, only the
// marked summary block, and never over a person's fresh edit.
import { STATUSES, PRIORITIES, teamRepos, type Team } from "./config";
import { github, refText, type IssueRef } from "./github";
import { HoustonError } from "./util";

export const SUMMARY_START = "<!-- houston:summary -->";
export const SUMMARY_END = "<!-- /houston:summary -->";
export const KINDS = ["bug", "feature", "task", "investigation"] as const;

/** A person's edit to an issue body within this window makes summary writes back off. */
export const RECENT_EDIT_MS = 10 * 60_000;

export function assertTeamRepo(team: Team, repo: string) {
  if (!teamRepos(team).some((r) => r.repo.toLowerCase() === repo.toLowerCase()))
    throw new HoustonError(`${repo} is not one of the team's repos in houston.yml, so Houston won't touch it.`);
}

/** Labels Houston may set: core statuses, priorities and kinds. Everything else belongs to people. */
export function allowedLabels(): string[] {
  return [...STATUSES.map((s) => `status:${s}`), ...PRIORITIES, ...KINDS.map((k) => `kind:${k}`)];
}

/**
 * Works out a label change under the team's rules. Setting a status removes the issue's other
 * status labels, so an issue is only ever in one column. Throws on anything the rules refuse.
 */
export function planLabels(team: Team, current: string[], add: string[], remove: string[]): { add: string[]; remove: string[] } {
  const allowed = allowedLabels();
  for (const l of [...add, ...remove]) {
    if (!allowed.includes(l)) throw new HoustonError(`"${l}" isn't a label Houston manages. Use one of: ${allowed.join(", ")}`);
    const isStatus = l.startsWith("status:");
    if (isStatus && team.rules.status === "never") throw new HoustonError("The team's rules say agents don't change status (rules.status: never).");
    if (!isStatus && team.rules.labels === "never") throw new HoustonError("The team's rules say agents don't change labels (rules.labels: never).");
  }
  const statuses = add.filter((l) => l.startsWith("status:"));
  if (statuses.length > 1) throw new HoustonError(`An issue has one status at a time; got ${statuses.join(" and ")}.`);
  const removeAll = new Set(remove);
  if (statuses.length) for (const l of current) if (l.startsWith("status:") && l !== statuses[0]) removeAll.add(l);
  if (add.some((l) => PRIORITIES.includes(l as any))) for (const l of current) if (PRIORITIES.includes(l as any) && !add.includes(l)) removeAll.add(l);
  return { add: add.filter((l) => !current.includes(l)), remove: [...removeAll].filter((l) => current.includes(l)) };
}

export function writeLabels(team: Team, ref: IssueRef, add: string[], remove: string[] = []) {
  assertTeamRepo(team, ref.repo);
  const gh = github();
  const plan = planLabels(team, gh.issue(ref).labels, add, remove);
  gh.editLabels(ref, plan.add, plan.remove);
  return plan;
}

/** The summary block in an issue body, without its markers, or undefined if there is none. */
export function readSummary(body: string): string | undefined {
  const s = body.indexOf(SUMMARY_START);
  const e = body.indexOf(SUMMARY_END);
  return s >= 0 && e > s ? body.slice(s + SUMMARY_START.length, e).trim() : undefined;
}

/** The issue body with the summary block taken out: the part people wrote. */
export function withoutSummary(body: string): string {
  const s = body.indexOf(SUMMARY_START);
  const e = body.indexOf(SUMMARY_END);
  return s >= 0 && e > s ? (body.slice(0, s) + body.slice(e + SUMMARY_END.length)).trim() : body.trim();
}

/** Replaces the summary block, or puts one at the top. Everything outside the markers is kept byte for byte. */
export function replaceSummary(body: string, summary: string): string {
  if (summary.includes(SUMMARY_START) || summary.includes(SUMMARY_END)) throw new HoustonError("A summary can't contain the houston:summary markers itself.");
  const block = `${SUMMARY_START}\n${summary.trim()}\n${SUMMARY_END}`;
  const s = body.indexOf(SUMMARY_START);
  const e = body.indexOf(SUMMARY_END);
  if (s >= 0 && e > s) return body.slice(0, s) + block + body.slice(e + SUMMARY_END.length);
  return body.trim() ? `${block}\n\n${body}` : block;
}

/**
 * Writes an issue's living summary. Re-reads the issue first and backs off if someone other than
 * `me` edited the body in the last 10 minutes, so a run never overwrites a person mid-edit.
 */
export function writeSummary(team: Team, ref: IssueRef, summary: string, now = new Date()): { written: boolean; note: string } {
  assertTeamRepo(team, ref.repo);
  if (!team.rules.summary_on_issue) return { written: false, note: "rules.summary_on_issue is false" };
  const gh = github();
  const issue = gh.issue(ref);
  const me = gh.login();
  if (issue.lastEditedAt && issue.editor && issue.editor !== me && now.getTime() - Date.parse(issue.lastEditedAt) < RECENT_EDIT_MS)
    return { written: false, note: `@${issue.editor} edited ${refText(ref)} in the last 10 minutes; trying again next run` };
  const body = replaceSummary(issue.body, summary);
  if (body === issue.body) return { written: false, note: "summary unchanged" };
  gh.setBody(ref, body);
  return { written: true, note: "summary updated" };
}
