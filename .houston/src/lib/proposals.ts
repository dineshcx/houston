// Intake proposals: proposals/<date>-<slug>.yml in the Houston repo. `houston propose` opens one as a
// pull request next to the meeting notes; once it's merged, `houston apply` makes each change through
// the shared issue rules and moves the file to proposals/applied/ with a record of what happened.
// The record is written after every change that lands, so a retry continues instead of duplicating.
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { Checker, LOGIN, PRIORITIES, readYaml, STATUSES, type Team } from "./config";
import { github, parseRef, refText, type IssueRef } from "./github";
import { ISSUE_KINDS, SUMMARY_END, SUMMARY_START, assertTeamRepo, postComment, readSummary, replaceSummary, writeLabels, writeSummary } from "./issues";
import { writeInRepo } from "./pages";
import { paths } from "./paths";
import { commitAndPush, defaultBranch, git, houstonRepo, notReady } from "./repo";
import { HoustonError, iso } from "./util";

export type Create = { repo: string; title: string; goal?: string; next_step?: string; assignee?: string; priority?: string; kind?: string; raised_by?: string; parent?: number | string };
export type Update = { issue: string; add_decision?: string; add_question?: string; next_step?: string; status?: string };
export type Comment = { issue: string; body: string };
export type Change = { create: Create } | { update: Update } | { comment: Comment };
export type Applied = { at: string; by: string; results: string[] };
export type Proposal = { title: string; owner?: string; project: string; source: string; changes: Change[]; skipped: string[]; applied?: Applied };

// The schema: every key each part may have. Anything else is refused, so a typo never drops a change.
const TOP = ["title", "owner", "project", "source", "changes", "skipped", "applied"];
const FIELDS = {
  create: ["repo", "title", "goal", "next_step", "assignee", "priority", "kind", "raised_by", "parent"],
  update: ["issue", "add_decision", "add_question", "next_step", "status"],
  comment: ["issue", "body"],
};

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Checks a parsed proposal against the schema and the team. Returns every problem, in plain words. */
export function validateProposal(raw: unknown, team: Team): { proposal?: Proposal; errors: string[] } {
  if (!isMap(raw)) return { errors: ["the proposal is empty or not a map of keys to values"] };
  const c = new Checker();
  const login = (v: unknown, path: string) => c.str(v, path, { optional: true, pattern: LOGIN, hint: "is not a GitHub username (write it without the @)" });
  const oneOf = (v: unknown, path: string, choices: readonly string[]) => v !== undefined && c.oneOf(v, path, choices);
  const teamRepo = (repo: string, path: string) => {
    try {
      assertTeamRepo(team, repo);
    } catch (e) {
      c.fail(path, message(e));
    }
  };
  const teamIssue = (v: unknown, path: string) => {
    try {
      teamRepo(parseRef(String(v)).repo, path);
    } catch (e) {
      c.fail(path, message(e));
    }
  };

  c.obj(raw, "", TOP);
  c.str(raw.title, "title");
  login(raw.owner, "owner");
  c.str(raw.source, "source");
  if (typeof raw.project !== "string" || !team.projects[raw.project])
    c.fail("project", `"${raw.project ?? ""}" is not a project in houston.yml. Choose one of: ${Object.keys(team.projects).join(", ")}`);

  const changes = c.list(raw.changes, "changes");
  changes.forEach((change, i) => {
    const path = `change ${i + 1}`;
    const kind = isMap(change) && Object.keys(change).length === 1 ? (Object.keys(change)[0] as keyof typeof FIELDS) : undefined;
    const fields = kind && FIELDS[kind] ? (change as Record<string, unknown>)[kind] : undefined;
    if (!kind || !isMap(fields)) return c.fail(path, "should be exactly one of create:, update: or comment:, followed by its fields");
    const f = c.obj(fields, `${path}.${kind}`, FIELDS[kind]);
    if (kind === "create") {
      if (team.rules.create_issue === "never") c.fail(path, "the team's rules say Houston doesn't create issues (rules.create_issue: never)");
      teamRepo(String(f.repo), `${path}.repo`);
      c.str(f.title, `${path}.title`);
      for (const k of ["goal", "next_step"]) c.str(f[k], `${path}.${k}`, { optional: true });
      login(f.assignee, `${path}.assignee`);
      login(f.raised_by, `${path}.raised_by`);
      oneOf(f.priority, `${path}.priority`, PRIORITIES);
      oneOf(f.kind, `${path}.kind`, ISSUE_KINDS);
      if (typeof f.parent === "number") {
        const target = changes[f.parent - 1];
        if (!Number.isInteger(f.parent) || f.parent < 1 || f.parent > i || !isMap(target) || !("create" in target))
          c.fail(`${path}.parent`, `${f.parent} should be the number of an earlier create in this list (1 is the first change)`);
      } else if (f.parent !== undefined) teamIssue(f.parent, `${path}.parent`);
    } else if (kind === "update") {
      teamIssue(f.issue, `${path}.issue`);
      for (const k of ["add_decision", "add_question", "next_step"]) c.str(f[k], `${path}.${k}`, { optional: true });
      // Only the team's own columns, so the issue shows up on their board.
      oneOf(f.status, `${path}.status`, team.status.columns.map((c) => c.label));
      if (!["add_decision", "add_question", "next_step", "status"].some((k) => f[k] !== undefined)) c.fail(path, "says nothing to change: add add_decision, add_question, next_step or status");
    } else {
      teamIssue(f.issue, `${path}.issue`);
      c.str(f.body, `${path}.body`);
    }
  });

  c.list(raw.skipped, "skipped").forEach((s, i) => typeof s !== "string" && c.fail(`skipped[${i + 1}]`, 'should be one line of text; put quotes around the whole line, like - "Caching: nobody owned it"'));

  if (raw.applied !== undefined && (!isMap(raw.applied) || !Array.isArray(raw.applied.results))) c.fail("applied", "is Houston's record of what was applied; leave it as Houston wrote it");
  return c.errors.length ? { errors: c.errors } : { errors: [], proposal: { skipped: [], changes: [], ...raw } as unknown as Proposal };
}

/** Parses and validates a proposal's text, or throws with every problem listed. */
export function parseProposal(text: string, team: Team, label: string): Proposal {
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(text);
  } catch (e) {
    throw new HoustonError(`${label} is not valid YAML: ${message(e)}`);
  }
  const { proposal, errors } = validateProposal(raw, team);
  if (!proposal) throw new HoustonError(`${label} has ${errors.length} problem(s):\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  return proposal;
}

/** Sets a top-level `key: value` line in the YAML text, keeping the rest of the person's file as written. */
export function setTopKey(text: string, key: string, value: string): string {
  const line = `${key}: ${JSON.stringify(value)}`;
  const re = new RegExp(`^${key}:.*$`, "m");
  return re.test(text) ? text.replace(re, () => line) : `${line}\n${text}`;
}

/** "Daily sync, 13 Nov!" → "daily-sync-13-nov" */
export const slugify = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/, "") || "intake";

const sourceLink = (p: Proposal) => {
  const repo = houstonRepo();
  return repo ? `[${p.title}](https://github.com/${repo}/blob/${defaultBranch()}/${p.source})` : `${p.title} (\`${p.source}\`)`;
};

// ---------- the pull request body ----------

/** One change in a line or two of markdown: the PR body and the app's review screen both show this. */
export function describeChange(change: Change): string {
  if ("create" in change) {
    const c = change.create;
    const bits = [c.priority, c.kind && `kind:${c.kind}`, c.assignee && `@${c.assignee}`, c.raised_by && `raised by @${c.raised_by}`];
    if (c.parent !== undefined) bits.push(`sub-issue of ${typeof c.parent === "number" ? `change ${c.parent}` : c.parent}`);
    const extra = [c.goal && `Goal: ${c.goal}`, c.next_step && `Next step: ${c.next_step}`].filter(Boolean).map((l) => `\n  ${l}`);
    return `Create in ${c.repo}: **${c.title}**${bits.some(Boolean) ? ` · ${bits.filter(Boolean).join(" · ")}` : ""}${extra.join("")}`;
  }
  if ("update" in change) {
    const u = change.update;
    const what = [u.add_decision && `decision "${u.add_decision}"`, u.add_question && `question "${u.add_question}"`, u.next_step && `next step "${u.next_step}"`, u.status && `status → ${u.status}`];
    return `Update ${u.issue}: ${what.filter(Boolean).join("; ")}`;
  }
  return `Comment on ${change.comment.issue}: "${change.comment.body}"`;
}

/** The PR body: the changes as a numbered checklist, what was left out, and how to review it. */
export function renderPrBody(p: Proposal, file: string): string {
  const lines = [`Intake from **${p.title}**, proposed by @${p.owner}, who applies it after merge.`, "", `**Notes:** \`${p.source}\``, `**Proposal:** \`${file}\``, "", "### Proposed changes"];
  lines.push(...(p.changes.length ? p.changes.map((c, i) => `- [ ] ${i + 1}. ${describeChange(c)}`) : ["None, only notes."]));
  if (p.skipped.length) lines.push("", "### Left out", ...p.skipped.map((s) => `- ${s}`));
  lines.push(
    "",
    "---",
    `To change anything, edit the files in this pull request on GitHub. Delete a change from the proposal to drop it (and fix any \`parent:\` number that pointed past it). **Merge** to apply: @${p.owner}'s next Houston run applies it, or anyone can run \`houston apply ${file}\`. **Close** to discard it.`,
  );
  return lines.join("\n");
}

// ---------- applying ----------

// ---------- the issue template ----------

const TEMPLATE_FIELDS = ["goal", "raised_by", "next_step"] as const;
type TemplateFields = Record<(typeof TEMPLATE_FIELDS)[number], string>;

/**
 * The living summary a new issue starts with: the team's templates/issue.md if it has one, else the
 * core's. Only the part between the summary markers is used. Throws on a template Houston can't fill.
 */
export function issueTemplate(): { file: string; summary: string } {
  const team = join(paths.root, "templates", "issue.md");
  const file = existsSync(team) ? team : join(paths.core, "templates", "issue.md");
  const where = relative(paths.root, file);
  const summary = readSummary(readFileSync(file, "utf8"));
  if (summary === undefined) throw new HoustonError(`${where} needs the summary between ${SUMMARY_START} and ${SUMMARY_END}.`);
  for (const m of summary.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g))
    if (!(TEMPLATE_FIELDS as readonly string[]).includes(m[1])) throw new HoustonError(`${where} uses {{${m[1]}}}; only ${TEMPLATE_FIELDS.map((f) => `{{${f}}}`).join(", ")} exist.`);
  return { file, summary };
}

/** A new issue's living summary, from the template. The next step is never left empty. */
export function newSummary(f: Partial<TemplateFields>): string {
  const values: TemplateFields = { goal: f.goal ?? "", raised_by: f.raised_by ?? "", next_step: f.next_step?.trim() || "not decided yet" };
  return issueTemplate().summary.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: keyof TemplateFields) => values[k]);
}

/** Adds a line at the end of a `### heading` section (creating the section if needed), unless it's already there. */
export function addToSection(summary: string, heading: string, line: string): string {
  if (summary.includes(line)) return summary;
  const lines = summary.split("\n");
  const h = lines.findIndex((l) => l.trim() === `### ${heading}`);
  if (h < 0) return `${summary.trimEnd()}\n\n### ${heading}\n${line}`;
  let end = h + 1;
  while (end < lines.length && !lines[end].startsWith("#")) end++;
  while (end > h + 1 && !lines[end - 1].trim()) end--;
  lines.splice(end, 0, line);
  return lines.join("\n");
}

function setField(summary: string, field: string, value: string): string {
  const line = `**${field}:** ${value}`;
  const re = new RegExp(`^\\*\\*${field}:\\*\\*.*$`, "m");
  return re.test(summary) ? summary.replace(re, () => line) : `${line}\n${summary}`;
}

const CREATED = /^created (\S+#\d+)/;
const isDone = (result?: string) => result !== undefined && !result.startsWith("failed") && !result.includes("; failed");

/** Makes change `i`, writing its result into results[i] as soon as anything lands on GitHub. */
function applyChange(team: Team, p: Proposal, i: number, results: string[]) {
  const gh = github();
  const change = p.changes[i];
  if ("create" in change) {
    const c = change.create;
    if (team.rules.create_issue === "never") throw new HoustonError("The team's rules say Houston doesn't create issues (rules.create_issue: never).");
    assertTeamRepo(team, c.repo);
    // A retry after a failed sub-issue link reuses the issue it already created.
    const prior = CREATED.exec(results[i] ?? "")?.[1];
    let ref: IssueRef;
    if (prior) ref = parseRef(prior);
    else {
      const labels = [
        ...(team.rules.status === "never" ? [] : ["status:todo"]),
        ...(team.rules.labels === "never" ? [] : [c.priority, c.kind && `kind:${c.kind}`].filter((l): l is string => !!l)),
      ];
      const body = replaceSummary("", newSummary({ goal: c.goal ?? c.title, raised_by: `@${c.raised_by ?? p.owner} in ${sourceLink(p)}`, next_step: c.next_step }));
      ref = gh.createIssue(c.repo, { title: c.title, body, labels, assignees: c.assignee ? [c.assignee] : [] });
    }
    const created = `created ${refText(ref)} https://github.com/${ref.repo}/issues/${ref.number}`;
    results[i] = created;
    if (c.parent === undefined) return;
    const parentRef = typeof c.parent === "number" ? CREATED.exec(results[c.parent - 1] ?? "")?.[1] : c.parent;
    if (!parentRef) throw new HoustonError(`its parent, change ${c.parent}, didn't create an issue`);
    if (team.rules.sub_issues === "never") return void (results[i] = `${created} (not linked under ${parentRef}: rules.sub_issues is never)`);
    gh.addSubIssue(parseRef(parentRef), ref);
    results[i] = `${created}, sub-issue of ${parentRef}`;
  } else if ("update" in change) {
    const u = change.update;
    const ref = parseRef(u.issue);
    const notes: string[] = [];
    if (u.add_decision || u.add_question || u.next_step) {
      if (!team.rules.summary_on_issue) notes.push("summary not changed: rules.summary_on_issue is false");
      else {
        const issue = gh.issue(ref);
        let s = readSummary(issue.body) ?? newSummary({ goal: issue.title, raised_by: "not recorded" });
        if (u.add_decision) s = addToSection(s, "Decisions", `- ${u.add_decision} (${sourceLink(p)})`);
        if (u.add_question) s = addToSection(s, "Open questions", `- [ ] ${u.add_question}`);
        if (u.next_step) s = setField(s, "Next step", u.next_step);
        const w = writeSummary(team, ref, s);
        // Backing off from a person's fresh edit is a failure to retry later, not a skip.
        if (!w.written && w.note !== "summary unchanged") throw new HoustonError(w.note);
        notes.push(w.note);
      }
    }
    if (u.status) {
      writeLabels(team, ref, [`status:${u.status}`]);
      notes.push(`status:${u.status}`);
    }
    results[i] = `updated ${u.issue} (${notes.join("; ")})`;
  } else {
    const c = change.comment;
    if (team.rules.issue_comment === "none") return void (results[i] = `skipped comment on ${c.issue}: rules.issue_comment is none`);
    const ref = parseRef(c.issue);
    assertTeamRepo(team, ref.repo);
    postComment(ref, c.body);
    results[i] = `commented on ${c.issue}`;
  }
}

/** The proposal text with Houston's `applied:` record at the end (replacing any earlier one). */
function withRecord(text: string, applied: Applied): string {
  const kept = text.replace(/^applied:[\s\S]*$/m, "").trimEnd();
  const results = applied.results.map((r, i) => `    - ${JSON.stringify(r ?? `change ${i + 1} not applied yet`)}`);
  return `${kept}\n\napplied:\n  at: ${JSON.stringify(applied.at)}\n  by: ${JSON.stringify(applied.by)}\n  results:\n${results.join("\n")}\n`;
}

const isTracked = (file: string) => git(["ls-files", "--error-unmatch", "--", relative(paths.root, file)]).ok;

/**
 * Applies one merged proposal: each change through the shared issue rules, then moves the file to
 * proposals/applied/ with the results and comments them on the intake PR. Changes already recorded
 * as applied are never repeated. Returns one line for the person.
 */
export function applyProposal(team: Team, file: string, me: string): string {
  const name = basename(file).replace(/\.ya?ml$/, "");
  const rel = relative(paths.root, file);
  if (!isTracked(file)) throw new HoustonError(`${rel} isn't in the Houston repo yet. Merge its intake pull request first, then apply it.`);
  const text = readFileSync(file, "utf8");
  const p = parseProposal(text, team, rel);
  const results = [...(p.applied?.results ?? [])];
  const dest = join(paths.proposals, "applied", `${name}.yml`);
  if (file === dest && p.changes.every((_, i) => isDone(results[i]))) return `${name}: already applied`;

  for (let i = 0; i < p.changes.length; i++) {
    if (isDone(results[i])) continue;
    try {
      applyChange(team, p, i, results);
    } catch (e) {
      results[i] = CREATED.test(results[i] ?? "") ? `${results[i]}; failed: ${message(e)}` : `failed: ${message(e)}`;
      // Record what landed before stopping, so the next attempt picks up from here.
      writeInRepo(file, withRecord(text, { at: iso(new Date()), by: me, results }));
      commitAndPush([file], `Intake: partly applied ${name}`);
      const doneCount = results.filter(isDone).length;
      throw new HoustonError(`${name}: applied ${doneCount} of ${p.changes.length} changes, then change ${i + 1} failed: ${message(e)}\nFix the cause and run \`houston apply ${rel}\` again; it continues from change ${i + 1}.`);
    }
  }

  writeInRepo(dest, withRecord(text, { at: iso(new Date()), by: me, results }));
  if (file !== dest) unlinkSync(file); // the merged proposal, a tracked file pendingProposals found
  commitAndPush(file === dest ? [dest] : [file, dest], `Intake: applied ${name}`);
  const note = commentOnPr(name, me, results);
  return [`${name}: applied ${p.changes.length} change(s)${note ? ` (${note})` : ""}`, ...results.map((r, i) => `  ${i + 1}. ${r}`)].join("\n");
}

/** Posts the results on the intake PR, found by its branch. Silent if there is no such PR. */
function commentOnPr(name: string, me: string, results: string[]): string | undefined {
  const repo = houstonRepo();
  if (!repo) return;
  try {
    const pr = github()
      .pullRequests(repo, { state: "all" })
      .find((x) => x.branch === `intake/${name}`);
    if (!pr) return;
    const body = [`Applied by @${me}:`, "", ...(results.length ? results.map((r, i) => `${i + 1}. ${r}`) : ["No issue changes; the notes are in."])].join("\n");
    postComment(pr, body);
  } catch (e) {
    // The changes are made and recorded; a missing PR comment isn't worth failing over.
    return `couldn't comment on the pull request: ${message(e)}`;
  }
}

/** Proposal files merged into the Houston repo and not applied yet. */
export function pendingProposals(): string[] {
  return git(["ls-files", "--", "proposals"])
    .stdout.split("\n")
    .filter((f) => /^proposals\/[^/]+\.ya?ml$/.test(f))
    .map((f) => join(paths.root, f));
}

/** Throws unless the Houston repo is on its default branch (the only place merged proposals are) and not mid-rebase. */
export function assertOnDefaultBranch() {
  const busy = notReady();
  if (busy) throw new HoustonError(`Proposals weren't applied: ${busy}`);
}

const ownerOf = (file: string) => {
  try {
    return (readYaml(file) as { owner?: string })?.owner;
  } catch {
    return undefined;
  }
};

/**
 * Applies merged proposals owned by `me` that haven't been applied yet. Returns one line per proposal.
 * Doesn't pull: the caller has just pulled the Houston repo, so it pulls once per run.
 */
export function applyMergedProposals(team: Team, me: string): string[] {
  try {
    assertOnDefaultBranch();
  } catch (e) {
    return [message(e)];
  }
  return pendingProposals()
    .filter((f) => existsSync(f) && ownerOf(f) === me)
    .map((f) => {
      try {
        return applyProposal(team, f, me);
      } catch (e) {
        return message(e);
      }
    });
}
