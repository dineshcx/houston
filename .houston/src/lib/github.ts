// The only way Houston talks to GitHub. Everything goes through the person's own `gh` login.
// Tests (and dry runs) set HOUSTON_FAKE_GITHUB=<file.json> to use a file-backed GitHub instead.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { HoustonError, iso, must, sh } from "./util";

export type IssueRef = { repo: string; number: number };

export type Issue = IssueRef & {
  title: string;
  state: "open" | "closed";
  body: string;
  labels: string[];
  assignees: string[];
  url: string;
  updatedAt: string;
  /** When a person last edited the body, if ever. Summary writes back off when this is recent. */
  lastEditedAt?: string | null;
  editor?: string | null;
};

export type PullRequest = IssueRef & {
  title: string;
  body: string;
  state: "open" | "closed" | "merged";
  url: string;
  branch: string;
  author: string;
  labels: string[];
  updatedAt: string;
};

/** One thing a person did on GitHub: a comment, review, issue opened or closed, PR or commit. */
export type Activity = { at: string; repo: string; kind: string; number?: number; branch?: string; text: string };

export interface GitHub {
  login(): string;
  activity(user: string, repos: string[], since: Date): Activity[];
  issues(repo: string, opts?: { assignee?: string; label?: string; state?: "open" | "all" }): Issue[];
  issue(ref: IssueRef): Issue;
  pullRequests(repo: string, opts?: { author?: string; label?: string; state?: "open" | "all" }): PullRequest[];
  setBody(ref: IssueRef, body: string): void;
  editLabels(ref: IssueRef, add: string[], remove: string[]): void;
  ensureLabel(repo: string, name: string, color: string, description: string): void;
  createIssue(repo: string, issue: { title: string; body: string; labels?: string[]; assignees?: string[] }): IssueRef;
  comment(ref: IssueRef, body: string): void;
  addSubIssue(parent: IssueRef, child: IssueRef): void;
  createPullRequest(repo: string, pr: { head: string; base: string; title: string; body: string; labels?: string[] }): string;
  mergePullRequest(repo: string, number: number): void;
  visibility(repo: string): "public" | "private" | "internal";
}

const REF = /^([\w.-]+\/[\w.-]+)#(\d+)$/;

export function parseRef(text: string): IssueRef {
  const m = REF.exec(text.trim());
  if (!m) throw new HoustonError(`"${text}" is not an issue. Write it as owner/repo#123.`);
  return { repo: m[1], number: Number(m[2]) };
}

export const refText = (r: IssueRef) => `${r.repo}#${r.number}`;

// ---------- the real thing, through gh ----------

function gh(args: string[], input?: unknown): string {
  return must(["gh", ...args], input === undefined ? {} : { input: JSON.stringify(input) });
}

const json = <T>(text: string): T => (text ? JSON.parse(text) : ([] as T));
const lower = (s: string) => s.toLowerCase();

class GhGitHub implements GitHub {
  private me?: string;

  login() {
    if (!this.me) {
      const r = sh(["gh", "api", "user", "-q", ".login"]);
      if (!r.ok) throw new HoustonError("gh is not signed in. Run `gh auth login` first.");
      this.me = r.stdout;
    }
    return this.me;
  }

  /**
   * What the person did in these repos since `since`. GitHub's events feed no longer carries PR
   * titles, bodies or pushed commits, so those come from search; comments, reviews and issues
   * opened or closed still come from events.
   */
  activity(user: string, repos: string[], since: Date): Activity[] {
    const out = [...this.events(user, repos, since), ...this.searchPRs(user, repos, since), ...this.searchCommits(user, repos, since)];
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }

  private events(user: string, repos: string[], since: Date): Activity[] {
    const wanted = new Set(repos.map(lower));
    const out: Activity[] = [];
    for (let page = 1; page <= 3; page++) {
      const batch = json<any[]>(gh(["api", "-X", "GET", `users/${user}/events`, "-f", "per_page=100", "-f", `page=${page}`]));
      for (const e of batch) {
        if (new Date(e.created_at) < since || !wanted.has(lower(e.repo.name))) continue;
        const a = toActivity(e);
        if (a) out.push(a);
      }
      if (batch.length < 100 || new Date(batch.at(-1).created_at) < since) break;
    }
    return out;
  }

  /** Runs a search over the team's repos, a few repos per query so each stays under GitHub's length limit. */
  private search(endpoint: string, terms: string, repos: string[]): any[] {
    return searchQueries(terms, repos).flatMap((q) => json<{ items: any[] }>(gh(["api", "-X", "GET", endpoint, "-f", `q=${q}`, "-f", "per_page=100"])).items);
  }

  private searchPRs(user: string, repos: string[], since: Date): Activity[] {
    return this.search("search/issues", `is:pr author:${user} updated:>=${iso(since)}`, repos).map((p) => {
      const repo = String(p.repository_url).split("/repos/")[1];
      const merged = p.pull_request?.merged_at;
      const text = `${p.title ?? ""}\n${p.body ?? ""}`;
      // The branch name only helps match an issue when the PR's own text doesn't name one.
      const branch = /#\d+/.test(text) ? undefined : sh(["gh", "pr", "view", String(p.number), "-R", repo, "--json", "headRefName", "-q", ".headRefName"]).stdout || undefined;
      const kind = merged ? "merged PR" : p.state === "closed" ? "closed PR" : "open PR";
      return { at: merged ?? p.closed_at ?? p.updated_at, repo, kind, number: p.number, branch, text };
    });
  }

  private searchCommits(user: string, repos: string[], since: Date): Activity[] {
    return this.search("search/commits", `author:${user} committer-date:>=${iso(since)}`, repos).map((c) => ({
      at: iso(new Date(c.commit.committer.date)),
      repo: c.repository.full_name,
      kind: `commit ${String(c.sha).slice(0, 7)}`,
      text: String(c.commit.message).split("\n")[0],
    }));
  }

  issues(repo: string, opts: { assignee?: string; label?: string; state?: "open" | "all" } = {}): Issue[] {
    const args = ["issue", "list", "-R", repo, "--state", opts.state ?? "open", "--limit", "300", "--json", "number,title,state,body,labels,assignees,url,updatedAt"];
    if (opts.assignee) args.push("--assignee", opts.assignee);
    if (opts.label) args.push("--label", opts.label);
    return json<any[]>(gh(args)).map((i) => ({
      repo,
      number: i.number,
      title: i.title,
      state: lower(i.state) as Issue["state"],
      body: i.body ?? "",
      labels: i.labels.map((l: any) => l.name),
      assignees: i.assignees.map((a: any) => a.login),
      url: i.url,
      updatedAt: i.updatedAt,
    }));
  }

  issue(ref: IssueRef): Issue {
    const [owner, name] = ref.repo.split("/");
    const q = `query($o:String!,$n:String!,$num:Int!){repository(owner:$o,name:$n){issue(number:$num){number title state body url updatedAt lastEditedAt editor{login} labels(first:100){nodes{name}} assignees(first:20){nodes{login}}}}}`;
    const data = JSON.parse(gh(["api", "graphql", "-f", `query=${q}`, "-f", `o=${owner}`, "-f", `n=${name}`, "-F", `num=${ref.number}`]));
    const i = data.data?.repository?.issue;
    if (!i) throw new HoustonError(`${refText(ref)} is not an issue you can see.`);
    return {
      ...ref,
      title: i.title,
      state: lower(i.state) as Issue["state"],
      body: i.body ?? "",
      labels: i.labels.nodes.map((l: any) => l.name),
      assignees: i.assignees.nodes.map((a: any) => a.login),
      url: i.url,
      updatedAt: i.updatedAt,
      lastEditedAt: i.lastEditedAt,
      editor: i.editor?.login ?? null,
    };
  }

  pullRequests(repo: string, opts: { author?: string; label?: string; state?: "open" | "all" } = {}): PullRequest[] {
    const args = ["pr", "list", "-R", repo, "--state", opts.state ?? "open", "--limit", "100", "--json", "number,title,body,state,url,headRefName,author,labels,updatedAt"];
    if (opts.author) args.push("--author", opts.author);
    if (opts.label) args.push("--label", opts.label);
    return json<any[]>(gh(args)).map((p) => ({
      repo,
      number: p.number,
      title: p.title,
      body: p.body ?? "",
      state: lower(p.state) as PullRequest["state"],
      url: p.url,
      branch: p.headRefName,
      author: p.author?.login ?? "",
      labels: p.labels.map((l: any) => l.name),
      updatedAt: p.updatedAt,
    }));
  }

  setBody(ref: IssueRef, body: string) {
    gh(["api", "-X", "PATCH", `repos/${ref.repo}/issues/${ref.number}`, "--input", "-"], { body });
  }

  editLabels(ref: IssueRef, add: string[], remove: string[]) {
    if (!add.length && !remove.length) return;
    const args = ["issue", "edit", String(ref.number), "-R", ref.repo];
    if (add.length) args.push("--add-label", add.join(","));
    if (remove.length) args.push("--remove-label", remove.join(","));
    gh(args);
  }

  ensureLabel(repo: string, name: string, color: string, description: string) {
    gh(["label", "create", name, "-R", repo, "--color", color, "--description", description, "--force"]);
  }

  createIssue(repo: string, issue: { title: string; body: string; labels?: string[]; assignees?: string[] }): IssueRef {
    const created = JSON.parse(gh(["api", "-X", "POST", `repos/${repo}/issues`, "--input", "-"], issue));
    return { repo, number: created.number };
  }

  comment(ref: IssueRef, body: string) {
    gh(["api", "-X", "POST", `repos/${ref.repo}/issues/${ref.number}/comments`, "--input", "-"], { body });
  }

  addSubIssue(parent: IssueRef, child: IssueRef) {
    const id = Number(gh(["api", `repos/${child.repo}/issues/${child.number}`, "-q", ".id"]));
    gh(["api", "-X", "POST", `repos/${parent.repo}/issues/${parent.number}/sub_issues`, "--input", "-"], { sub_issue_id: id });
  }

  createPullRequest(repo: string, pr: { head: string; base: string; title: string; body: string; labels?: string[] }): string {
    for (const l of pr.labels ?? []) sh(["gh", "label", "create", l, "-R", repo, "--color", "5319e7", "--force"]);
    const args = ["pr", "create", "-R", repo, "--head", pr.head, "--base", pr.base, "--title", pr.title, "--body-file", "-"];
    for (const l of pr.labels ?? []) args.push("--label", l);
    return must(["gh", ...args], { input: pr.body });
  }

  mergePullRequest(repo: string, number: number) {
    gh(["pr", "merge", String(number), "-R", repo, "--merge", "--delete-branch"]);
  }

  visibility(repo: string) {
    return lower(gh(["api", `repos/${repo}`, "-q", ".visibility"])) as "public" | "private" | "internal";
  }
}

/** Search queries: `terms` plus repo: qualifiers, split so none passes GitHub's 256-character limit. */
export function searchQueries(terms: string, repos: string[], limit = 250): string[] {
  const out: string[] = [];
  let q = terms;
  for (const r of repos) {
    if (q !== terms && q.length + r.length + 6 > limit) {
      out.push(q);
      q = terms;
    }
    q += ` repo:${r}`;
  }
  return repos.length ? [...out, q] : [];
}

/**
 * Turns one GitHub event into one line of activity, or nothing if it isn't work worth reporting.
 * PRs and commits come from search instead. Issue label, assignee and edit events are left out:
 * they are mostly Houston's own writes from the last publish, not new work.
 */
export function toActivity(e: any): Activity | undefined {
  const p = e.payload ?? {};
  const base = { at: e.created_at, repo: e.repo.name };
  const num = (p.issue ?? p.pull_request)?.number;
  switch (e.type) {
    case "IssueCommentEvent":
      return { ...base, kind: "commented", number: num, text: p.comment?.body ?? "" };
    case "PullRequestReviewEvent":
      return { ...base, kind: "reviewed", number: num, text: (p.review?.state ?? "").toLowerCase() };
    case "IssuesEvent":
      if (!["opened", "closed", "reopened"].includes(p.action)) return undefined;
      return { ...base, kind: `${p.action} issue`, number: num, text: p.issue?.title ?? "" };
  }
}

// ---------- a file-backed GitHub, for tests and dry runs ----------

export type FakeData = {
  login: string;
  activity: Activity[];
  issues: (Issue & { comments?: string[] })[];
  pulls: PullRequest[];
  labels: Record<string, string[]>;
  subIssues: string[][];
  visibility: Record<string, "public" | "private" | "internal">;
  /** Every write, in order, so tests can assert on them. */
  writes: string[];
};

export class FakeGitHub implements GitHub {
  constructor(private file: string) {}

  private read(): FakeData {
    const d = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : {};
    return { login: "me", activity: [], issues: [], pulls: [], labels: {}, subIssues: [], visibility: {}, writes: [], ...d };
  }
  private write(d: FakeData, note: string) {
    d.writes.push(note);
    writeFileSync(this.file, JSON.stringify(d, null, 2));
  }
  private find(d: FakeData, ref: IssueRef) {
    const i = d.issues.find((x) => lower(x.repo) === lower(ref.repo) && x.number === ref.number);
    if (!i) throw new HoustonError(`${refText(ref)} is not an issue you can see.`);
    return i;
  }

  login() {
    return this.read().login;
  }
  activity(_user: string, repos: string[], since: Date) {
    const wanted = new Set(repos.map(lower));
    return this.read().activity.filter((a) => wanted.has(lower(a.repo)) && new Date(a.at) >= since);
  }
  issues(repo: string, opts: { assignee?: string; label?: string; state?: "open" | "all" } = {}) {
    return this.read().issues.filter(
      (i) =>
        lower(i.repo) === lower(repo) &&
        (opts.state === "all" || i.state === "open") &&
        (!opts.assignee || i.assignees.includes(opts.assignee)) &&
        (!opts.label || i.labels.includes(opts.label)),
    );
  }
  issue(ref: IssueRef) {
    return this.find(this.read(), ref);
  }
  pullRequests(repo: string, opts: { author?: string; label?: string; state?: "open" | "all" } = {}) {
    return this.read().pulls.filter(
      (p) => lower(p.repo) === lower(repo) && (opts.state === "all" || p.state === "open") && (!opts.author || p.author === opts.author) && (!opts.label || p.labels.includes(opts.label)),
    );
  }
  setBody(ref: IssueRef, body: string) {
    const d = this.read();
    const i = this.find(d, ref);
    i.body = body;
    i.updatedAt = new Date().toISOString();
    this.write(d, `body ${refText(ref)}`);
  }
  editLabels(ref: IssueRef, add: string[], remove: string[]) {
    const d = this.read();
    const i = this.find(d, ref);
    // Like GitHub, refuse a label the repo doesn't have (when the fake says which labels it has).
    const missing = add.filter((l) => d.labels[ref.repo] && !d.labels[ref.repo].includes(l));
    if (missing.length) throw new HoustonError(`'${missing[0]}' not found in ${ref.repo}`);
    i.labels = [...new Set([...i.labels.filter((l) => !remove.includes(l)), ...add])];
    this.write(d, `labels ${refText(ref)} +${add.join(",")} -${remove.join(",")}`);
  }
  ensureLabel(repo: string, name: string) {
    const d = this.read();
    d.labels[repo] = [...new Set([...(d.labels[repo] ?? []), name])];
    this.write(d, `label ${repo} ${name}`);
  }
  createIssue(repo: string, issue: { title: string; body: string; labels?: string[]; assignees?: string[] }) {
    const d = this.read();
    const number = Math.max(0, ...d.issues.filter((i) => lower(i.repo) === lower(repo)).map((i) => i.number), ...d.pulls.filter((p) => lower(p.repo) === lower(repo)).map((p) => p.number)) + 1;
    d.issues.push({ repo, number, title: issue.title, body: issue.body, labels: issue.labels ?? [], assignees: issue.assignees ?? [], state: "open", url: `https://github.com/${repo}/issues/${number}`, updatedAt: new Date().toISOString() });
    this.write(d, `create ${refText({ repo, number })} ${issue.title}`);
    return { repo, number };
  }
  comment(ref: IssueRef, body: string) {
    const d = this.read();
    // GitHub takes comments on pull requests through the same issues endpoint.
    const pr = d.pulls.find((p) => lower(p.repo) === lower(ref.repo) && p.number === ref.number) as (PullRequest & { comments?: string[] }) | undefined;
    const i = pr ?? this.find(d, ref);
    (i.comments ??= []).push(body);
    this.write(d, `comment ${refText(ref)}`);
  }
  addSubIssue(parent: IssueRef, child: IssueRef) {
    const d = this.read();
    d.subIssues.push([refText(parent), refText(child)]);
    this.write(d, `sub-issue ${refText(parent)} > ${refText(child)}`);
  }
  createPullRequest(repo: string, pr: { head: string; base: string; title: string; body: string; labels?: string[] }) {
    const d = this.read();
    const number = Math.max(0, ...d.pulls.filter((p) => lower(p.repo) === lower(repo)).map((p) => p.number), ...d.issues.filter((i) => lower(i.repo) === lower(repo)).map((i) => i.number)) + 1;
    const url = `https://github.com/${repo}/pull/${number}`;
    d.pulls.push({ repo, number, title: pr.title, body: pr.body, state: "open", url, branch: pr.head, author: d.login, labels: pr.labels ?? [], updatedAt: new Date().toISOString() });
    this.write(d, `pr ${refText({ repo, number })} ${pr.title}`);
    return url;
  }
  mergePullRequest(repo: string, number: number) {
    const d = this.read();
    const p = d.pulls.find((x) => lower(x.repo) === lower(repo) && x.number === number);
    if (!p) throw new HoustonError(`${refText({ repo, number })} is not a pull request.`);
    p.state = "merged";
    this.write(d, `merge ${refText({ repo, number })}`);
  }
  visibility(repo: string) {
    return this.read().visibility[repo] ?? "private";
  }
}

let instance: GitHub | undefined;

/** The GitHub every command uses. */
export function github(): GitHub {
  return (instance ??= process.env.HOUSTON_FAKE_GITHUB ? new FakeGitHub(process.env.HOUSTON_FAKE_GITHUB) : new GhGitHub());
}
