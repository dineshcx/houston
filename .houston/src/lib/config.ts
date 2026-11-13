// houston.yml (the team's setup, committed) and houston.local.yml (one person's machine, gitignored).
// The validator is the schema: unknown keys are refused, so a typo never silently turns a feature off,
// and every error is written in plain words for whoever (or whichever agent) edits the file.
import { existsSync, readFileSync } from "node:fs";
import { loadCadences, type Cadence } from "./cadence";
import { paths } from "./paths";
import { HoustonError, parseDuration } from "./util";

export const SCHEMA_VERSION = 1;

/** Status labels are owned by core and identical in every repo, so two teams sharing a repo never fight. */
export const STATUSES = ["backlog", "todo", "in-progress", "in-review", "blocked", "ready-for-agent"] as const;
export type Status = (typeof STATUSES)[number];
export const PRIORITIES = ["p0", "p1", "p2", "p3"] as const;

export type Rules = {
  status: "auto" | "never";
  labels: "auto" | "never";
  create_issue: "review" | "never";
  sub_issues: "auto" | "never";
  issue_comment: "none" | "blockers_only" | "summary_changes";
  summary_on_issue: boolean;
  publish_runs: "auto" | "review" | "review_until_deadline";
  publish_deadline: string;
};

export type Repo = { repo: string; about?: string };
export type Project = { name: string; repos: Repo[]; cadences: string[] };

export type Team = {
  houston: number;
  core: string;
  template?: string;
  team: { name: string; leads: string[]; members: string[] };
  projects: Record<string, Project>;
  status: { columns: { label: Status; name: string }[] };
  priority: Record<(typeof PRIORITIES)[number], string>;
  rules: Rules;
  runs: { every: string; model: string; max_turns: number };
  agents: { enabled: boolean };
};

export type Local = {
  user: string;
  timezone: string;
  /** owner/name → absolute path on this machine, or null for "not on this machine". */
  repos: Record<string, string | null>;
  /** One sentence saying which scheduler runs `houston run` for this person, and when. */
  schedule?: string;
};

export const DEFAULT_RULES: Rules = {
  status: "auto",
  labels: "auto",
  create_issue: "review",
  sub_issues: "auto",
  issue_comment: "blockers_only",
  summary_on_issue: true,
  publish_runs: "review_until_deadline",
  publish_deadline: "15m",
};

const DEFAULTS = {
  status: {
    columns: [
      { label: "todo", name: "Todo" },
      { label: "in-progress", name: "In progress" },
      { label: "in-review", name: "In review" },
      { label: "blocked", name: "Blocked" },
    ],
  },
  priority: { p0: "Urgent", p1: "High", p2: "Medium", p3: "Low" },
  runs: { every: "3h", model: "haiku", max_turns: 12 },
  agents: { enabled: false },
};

const RULE_CHOICES: Record<keyof Rules, readonly unknown[] | "duration"> = {
  status: ["auto", "never"],
  labels: ["auto", "never"],
  create_issue: ["review", "never"],
  sub_issues: ["auto", "never"],
  issue_comment: ["none", "blockers_only", "summary_changes"],
  summary_on_issue: [true, false],
  publish_runs: ["auto", "review", "review_until_deadline"],
  publish_deadline: "duration",
};

export const REPO = /^[\w.-]+\/[\w.-]+$/;
export const LOGIN = /^[A-Za-z0-9-]+$/;
const ID = /^[a-z0-9][a-z0-9-]*$/;

/** Validates parsed YAML, collecting every problem in plain words instead of stopping at the first. */
export class Checker {
  errors: string[] = [];
  fail(path: string, msg: string) {
    this.errors.push(`${path}: ${msg}`);
  }
  obj(v: unknown, path: string, allowed: string[]): Record<string, unknown> {
    if (v === undefined || v === null) return {};
    if (typeof v !== "object" || Array.isArray(v)) {
      this.fail(path, "should be a map of keys to values");
      return {};
    }
    for (const k of Object.keys(v)) if (!allowed.includes(k)) this.fail(path ? `${path}.${k}` : k, `unknown key. Allowed here: ${allowed.join(", ")}`);
    return v as Record<string, unknown>;
  }
  str(v: unknown, path: string, opts: { pattern?: RegExp; hint?: string; optional?: boolean } = {}): string {
    if (v === undefined && opts.optional) return "";
    if (typeof v !== "string" || !v.trim()) return this.fail(path, "should be some text"), "";
    if (opts.pattern && !opts.pattern.test(v)) this.fail(path, `"${v}" ${opts.hint ?? "is not valid"}`);
    return v;
  }
  list(v: unknown, path: string): unknown[] {
    if (v === undefined) return [];
    if (!Array.isArray(v)) return this.fail(path, "should be a list"), [];
    return v;
  }
  oneOf<T>(v: unknown, path: string, choices: readonly T[]): T {
    if (!choices.includes(v as T)) this.fail(path, `"${v}" is not allowed. Choose one of: ${choices.join(", ")}`);
    return v as T;
  }
}

/** Checks a parsed houston.yml. Returns the team with defaults filled in, or every problem found. */
export function validateTeam(raw: unknown, cadenceNames?: string[]): { team?: Team; errors: string[] } {
  const c = new Checker();
  const top = c.obj(raw, "", ["houston", "core", "template", "team", "projects", "status", "priority", "rules", "runs", "agents"]);
  if (raw === null || typeof raw !== "object") return { errors: ["houston.yml is empty or not a map of keys to values"] };

  if (top.houston !== SCHEMA_VERSION) c.fail("houston", `should be ${SCHEMA_VERSION} (the schema version this core reads)`);
  c.str(top.core, "core", { hint: "should be the core version, like 0.1.0" });
  c.str(top.template, "template", { optional: true, pattern: REPO, hint: "should be owner/name of the Houston template repo" });

  const team = c.obj(top.team, "team", ["name", "leads", "members"]);
  c.str(team.name, "team.name");
  const members = c.list(team.members, "team.members").map((m, i) => c.str(m, `team.members[${i}]`, { pattern: LOGIN, hint: "is not a GitHub username" }));
  const leads = c.list(team.leads, "team.leads").map((m, i) => c.str(m, `team.leads[${i}]`, { pattern: LOGIN, hint: "is not a GitHub username" }));
  if (!leads.length) c.fail("team.leads", "needs at least one lead");
  for (const l of leads) if (l && !members.includes(l)) c.fail("team.leads", `${l} is a lead but not in team.members`);

  const projects: Record<string, Project> = {};
  const projectsRaw = c.obj(top.projects, "projects", Object.keys((top.projects as object) ?? {}));
  if (!Object.keys(projectsRaw).length) c.fail("projects", "needs at least one project");
  const seenRepos = new Map<string, string>();
  for (const [id, p] of Object.entries(projectsRaw)) {
    const path = `projects.${id}`;
    if (!ID.test(id)) c.fail(path, "project ids use lowercase letters, digits and dashes, like agentic-reviewer");
    const po = c.obj(p, path, ["name", "repos", "cadences"]);
    const repos = c.list(po.repos, `${path}.repos`).map((r, i): Repo => {
      // A plain "owner/name" string is accepted as shorthand for { repo: owner/name }.
      const ro = typeof r === "string" ? { repo: r } : c.obj(r, `${path}.repos[${i}]`, ["repo", "about"]);
      const repo = c.str(ro.repo, `${path}.repos[${i}].repo`, { pattern: REPO, hint: "should be owner/name" });
      if (seenRepos.has(repo)) c.fail(`${path}.repos`, `${repo} is already in project ${seenRepos.get(repo)}; a repo belongs to one project per team`);
      seenRepos.set(repo, id);
      return ro.about ? { repo, about: String(ro.about) } : { repo };
    });
    if (!repos.length) c.fail(`${path}.repos`, "needs at least one repo");
    const cadences = c.list(po.cadences, `${path}.cadences`).map((x, i) => c.str(x, `${path}.cadences[${i}]`));
    if (cadenceNames) for (const x of cadences) if (x && !cadenceNames.includes(x)) c.fail(`${path}.cadences`, `there is no cadences/${x}.md`);
    projects[id] = { name: c.str(po.name, `${path}.name`), repos, cadences };
  }

  const st = c.obj(top.status, "status", ["columns"]);
  const columns = (st.columns === undefined ? DEFAULTS.status.columns : c.list(st.columns, "status.columns")).map((col, i) => {
    const co = c.obj(col, `status.columns[${i}]`, ["label", "name"]);
    return { label: c.oneOf(co.label, `status.columns[${i}].label`, STATUSES), name: c.str(co.name, `status.columns[${i}].name`) };
  });

  const prRaw = c.obj(top.priority, "priority", [...PRIORITIES]);
  const priority = { ...DEFAULTS.priority, ...prRaw } as Team["priority"];

  const rulesRaw = c.obj(top.rules, "rules", Object.keys(RULE_CHOICES));
  const rules = { ...DEFAULT_RULES } as Record<string, unknown>;
  for (const [k, v] of Object.entries(rulesRaw)) {
    const choices = RULE_CHOICES[k as keyof Rules];
    if (!choices) continue;
    if (choices === "duration") {
      try {
        parseDuration(String(v));
      } catch (e) {
        c.fail(`rules.${k}`, (e as Error).message);
      }
    } else c.oneOf(v, `rules.${k}`, choices);
    rules[k] = v;
  }

  const runsRaw = c.obj(top.runs, "runs", ["every", "model", "max_turns"]);
  const runs = { ...DEFAULTS.runs, ...runsRaw };
  try {
    parseDuration(runs.every);
  } catch (e) {
    c.fail("runs.every", (e as Error).message);
  }
  if (!Number.isInteger(runs.max_turns) || runs.max_turns < 1) c.fail("runs.max_turns", "should be a whole number above 0");

  const agents = { ...DEFAULTS.agents, ...c.obj(top.agents, "agents", ["enabled"]) };

  if (c.errors.length) return { errors: c.errors };
  return {
    errors: [],
    team: {
      houston: top.houston as number,
      core: top.core as string,
      ...(top.template ? { template: top.template as string } : {}),
      team: { name: team.name as string, leads, members },
      projects,
      status: { columns },
      priority,
      rules: rules as Rules,
      runs,
      agents,
    },
  };
}

/** Parses a YAML file, or throws a plain-words error naming it. */
export function readYaml(path: string, what = path): unknown {
  try {
    return Bun.YAML.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new HoustonError(`${what} is not valid YAML: ${(e as Error).message}`);
  }
}

/** Loads and validates houston.yml, or throws with every problem listed. */
export function loadTeam(file = paths.team, cadenceNames?: string[]): Team {
  if (!existsSync(file)) throw new HoustonError(`No houston.yml in ${paths.root}. Open your agent here and say "set me up".`);
  const { team, errors } = validateTeam(readYaml(file, "houston.yml"), cadenceNames);
  if (!team) throw new HoustonError(`houston.yml has ${errors.length} problem(s):\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  return team;
}

/** Loads houston.local.yml, the person's own settings. */
export function loadLocal(file = paths.local): Local {
  if (!existsSync(file)) throw new HoustonError(`No houston.local.yml yet. Say "set me up" to your agent in the Houston repo, or run \`houston link\`.`);
  const raw = (readYaml(file, "houston.local.yml") ?? {}) as Record<string, unknown>;
  const c = new Checker();
  const o = c.obj(raw, "", ["user", "timezone", "repos", "schedule"]);
  const user = c.str(o.user, "user", { pattern: LOGIN, hint: "is not a GitHub username" });
  const timezone = c.str(o.timezone, "timezone");
  if (timezone && !isTimezone(timezone)) c.fail("timezone", `"${timezone}" is not a timezone like Asia/Kolkata or Europe/London`);
  const repos: Record<string, string | null> = {};
  for (const [repo, p] of Object.entries(c.obj(o.repos, "repos", Object.keys((o.repos as object) ?? {})))) {
    if (!REPO.test(repo)) c.fail(`repos.${repo}`, "should be owner/name");
    repos[repo] = p === null || p === "none" ? null : String(p).replace(/^~(?=\/)/, process.env.HOME ?? "~");
  }
  if (c.errors.length) throw new HoustonError(`houston.local.yml has problems:\n${c.errors.map((e) => `  - ${e}`).join("\n")}`);
  return { user, timezone, repos, ...(o.schedule ? { schedule: String(o.schedule) } : {}) };
}

export function isTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Every repo across the team's projects, with the project it belongs to. */
export function teamRepos(team: Team): { repo: string; project: string; about?: string }[] {
  return Object.entries(team.projects).flatMap(([project, p]) => p.repos.map((r) => ({ ...r, project })));
}

export function projectOf(team: Team, repo: string): string | undefined {
  return teamRepos(team).find((r) => r.repo.toLowerCase() === repo.toLowerCase())?.project;
}

/** Everything most commands need: the team, its cadences and this person's settings. */
export type Context = { team: Team; cadences: Record<string, Cadence>; local: Local };

export function loadContext(): Context {
  const cadences = loadCadences();
  return { team: loadTeam(paths.team, Object.keys(cadences)), cadences, local: loadLocal() };
}
