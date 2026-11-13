// houston explain: the team's setup in plain words, for people and for the app's Setup page.
import type { Command } from "../command";
import { loadCadences, type Cadence } from "../lib/cadence";
import { loadTeam, type Rules, type Source, type Team } from "../lib/config";
import { daysInWords } from "../lib/setup";

const PERIOD: Record<Cadence["period"], (c: Cadence) => string> = {
  day: () => "one page per day",
  week: () => "one page per week, starting Monday",
  month: () => "one page per month",
  sprint: (c) => `one page per ${c.sprint!.days}-day sprint (sprints start ${c.sprint!.start} and every ${c.sprint!.days} days after)`,
};

function source(id: string, s: Source): string {
  switch (s.kind) {
    case "github":
      return "GitHub activity";
    case "transcript":
      return `meeting transcripts (${id})`;
    case "email":
      return `email (${id})`;
    case "slack":
      return `Slack ${s.channel}${s.trigger === "reaction" ? `, threads someone reacts to with :${s.emoji ?? "ticket"}:` : ""}`;
  }
}

/** What each rule value lets agents do, in a sentence. */
function rules(r: Rules): string[] {
  const yes = (on: boolean, does: string, doesnt: string) => (on ? does : doesnt);
  return [
    yes(r.status === "auto", "Move issues between the team's status columns.", "Never change an issue's status; people do."),
    yes(r.labels === "auto", "Set priority and kind labels.", "Never change labels."),
    yes(r.assign_self === "auto", "Assign an issue to the person whose agent is working on it.", "Never assign issues."),
    { auto: "Create issues.", review: "Propose new issues; a person approves them in a pull request first.", never: "Never create issues." }[r.create_issue],
    { auto: "Create sub-issues.", with_owner: "Create sub-issues only in a session with the issue's owner.", never: "Never create sub-issues." }[r.sub_issues],
    yes(r.close_issue === "auto", "Close issues that are done.", "Never close an issue; people do."),
    { none: "Never comment on issues.", blockers_only: "Comment on an issue only to flag a blocker or a question for someone.", summary_changes: "Comment on an issue when its summary changes." }[r.issue_comment],
    yes(r.summary_on_issue, "Keep a living summary at the top of each issue they work on.", "Keep summaries off the issues."),
  ];
}

function publishing(team: Team): string {
  const { publish_runs, publish_deadline } = team.rules;
  const base = `Each person's scheduler runs \`houston run\` (about every ${team.runs.every}, plus a catch-up when they open their agent). A run that finds something new drafts their updates with ${team.runs.model} in at most ${team.runs.max_turns} turns.`;
  if (publish_runs === "auto") return `${base} Drafts publish straight away.`;
  if (publish_runs === "review") return `${base} Drafts wait until the person approves them.`;
  return `${base} The person can edit, approve or hold the draft; if they do nothing it publishes ${publish_deadline} before the cadence time, marked "not reviewed".`;
}

export function explain(team: Team, cadences: Record<string, Cadence>): string {
  const out: string[] = [];
  out.push(`${team.team.name}`, `Leads: ${team.team.leads.join(", ")}. Members: ${team.team.members.join(", ")}.`, "");
  for (const [id, p] of Object.entries(team.projects)) {
    out.push(`${p.name} (${id})`, "  Repos:");
    for (const r of p.repos) out.push(`    - ${r.repo}${r.about ? `: ${r.about}` : ""}`);
    out.push(p.cadences.length ? "  Cadences:" : "  No cadences.");
    for (const name of p.cadences) {
      const c = cadences[name];
      out.push(c ? `    - ${c.title}: ${daysInWords(c.schedule.days)} at ${c.schedule.time} in each person's own timezone; ${PERIOD[c.period](c)}` : `    - ${name}: no cadences/${name}.md (run \`houston validate\`)`);
    }
    out.push("");
  }
  out.push(`Status columns: ${team.status.columns.map((c) => `${c.name} (status:${c.label})`).join(", ")}.`);
  out.push(`Work comes from: ${Object.entries(team.sources).map(([id, s]) => source(id, s)).join("; ")}.`, "");
  out.push("What agents may do without asking:", ...rules(team.rules).map((r) => `  - ${r}`), "");
  out.push("How runs publish:", `  ${publishing(team)}`);
  return out.join("\n");
}

export default {
  summary: "The team's setup in plain words",
  usage: "houston explain",
  run() {
    console.log(explain(loadTeam(), loadCadences()));
  },
} satisfies Command;
