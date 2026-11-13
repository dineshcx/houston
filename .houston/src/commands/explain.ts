// houston explain: the team's setup in plain words, for people and for the app's Setup page.
import type { Command } from "../command";
import { loadCadences, type Cadence } from "../lib/cadence";
import { loadTeam, type Rules, type Team } from "../lib/config";
import { daysInWords } from "../lib/setup";

export const PERIOD: Record<Cadence["period"], (c: Cadence) => string> = {
  day: () => "one page per day",
  week: () => "one page per week, starting Monday",
  month: () => "one page per month",
  sprint: (c) => `one page per ${c.sprint!.days}-day sprint (sprints start ${c.sprint!.start} and every ${c.sprint!.days} days after)`,
};

/** What the rules let agents do, in sentences. */
export function rules(r: Rules): string[] {
  return [
    r.status === "auto" ? "Agents move issues between the team's status columns." : "Agents never change an issue's status; people do.",
    r.labels === "auto" ? "Agents set priority and kind labels." : "Agents never change priority or kind labels.",
    r.create_issue === "review" ? "Agents propose new issues from meetings and threads; a person approves them in a pull request before they're created." : "Houston never creates issues.",
    r.sub_issues === "auto" ? "Work that spans repos gets one main issue with a sub-issue in each other repo." : "Houston never links sub-issues; related issues stay separate.",
    {
      none: "Agents never comment on issues.",
      blockers_only: "Agents comment on an issue only to flag a blocker or a question for someone.",
      summary_changes: "Agents comment on an issue when its summary changes.",
    }[r.issue_comment],
    r.summary_on_issue ? "Agents keep a living summary at the top of each issue they work on, and never touch the rest of the issue." : "Agents keep summaries off the issues.",
    "Houston never closes issues; people do.",
  ];
}

export function publishing(team: Team): string {
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
  out.push("", "What Houston may do:", ...rules(team.rules).map((r) => `  - ${r}`), "");
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
