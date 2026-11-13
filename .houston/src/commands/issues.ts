// houston issues: the open issues across the team's repos, with their status and summary.
import { parseArgs } from "node:util";
import type { Command } from "../command";
import { loadLocal, loadTeam, teamRepos } from "../lib/config";
import { github, refText } from "../lib/github";
import { readSummary } from "../lib/issues";
import { HoustonError } from "../lib/util";

export default {
  summary: "List open issues across the team's repos, with status and summary",
  usage: `houston issues [--project <id>] [--mine] [--json]

  --project   only this project's repos
  --mine      only issues assigned to you
  --json      print JSON`,
  run(args) {
    const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: { project: { type: "string" }, mine: { type: "boolean" }, json: { type: "boolean" } } });
    const team = loadTeam();
    if (values.project && !team.projects[values.project]) throw new HoustonError(`There is no project "${values.project}". Projects: ${Object.keys(team.projects).join(", ")}.`);
    const gh = github();
    const assignee = values.mine ? loadLocal().user : undefined;
    const columns = new Map(team.status.columns.map((c) => [`status:${c.label}`, c.name]));
    const rows = teamRepos(team)
      .filter((r) => !values.project || r.project === values.project)
      .flatMap((r) =>
        gh.issues(r.repo, { assignee }).map((i) => {
          const label = i.labels.find((l) => l.startsWith("status:"));
          return { ref: refText(i), project: r.project, title: i.title, status: label ? (columns.get(label) ?? label) : null, assignees: i.assignees, summary: readSummary(i.body) !== undefined, url: i.url };
        }),
      );
    if (values.json) return console.log(JSON.stringify(rows, null, 2));
    if (!rows.length) return console.log(values.mine ? "No open issues assigned to you." : "No open issues.");
    for (const r of rows)
      console.log(`${r.ref.padEnd(24)} ${(r.status ?? "no status").padEnd(12)} ${(r.assignees.map((a) => `@${a}`).join(",") || "unassigned").padEnd(14)} ${r.summary ? "summary" : "no summary"}  ${r.title}`);
  },
} satisfies Command;
