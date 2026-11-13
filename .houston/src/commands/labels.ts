// houston labels: change an issue's labels under the team's rules, or create the core labels everywhere.
import type { Command } from "../command";
import { STATUSES, loadTeam, teamRepos } from "../lib/config";
import { github, parseRef } from "../lib/github";
import { KINDS, writeLabels } from "../lib/issues";
import { HoustonError } from "../lib/util";

const STATUS_COLORS: Record<string, string> = { backlog: "d4d4d4", todo: "c5def5", "in-progress": "fbca04", "in-review": "0075ca", blocked: "d73a4a", "ready-for-agent": "5319e7" };
const PRIORITY_COLORS: Record<string, string> = { p0: "b60205", p1: "d93f0b", p2: "fbca04", p3: "0e8a16" };
const KIND_COLORS: Record<string, string> = { bug: "d73a4a", feature: "a2eeef", task: "bfd4f2", investigation: "d4c5f9" };

export default {
  summary: "Change an issue's labels, or create the core labels in every team repo",
  usage: `houston labels <owner/repo#n> <label>… [-<label>]…   add labels; -label removes one
houston labels sync                                   create the status, priority and kind labels in every team repo`,
  run(args) {
    // Not parseArgs: "-status:todo" means "remove this label", which parseArgs would read as an option.
    const team = loadTeam();
    const gh = github();
    if (args[0] === "sync" && args.length === 1) {
      const columns = new Map(team.status.columns.map((c) => [c.label as string, c.name]));
      const labels = [
        ...STATUSES.map((s) => [`status:${s}`, STATUS_COLORS[s], `Status: ${columns.get(s) ?? s} (Houston)`]),
        ...Object.entries(team.priority).map(([p, name]) => [p, PRIORITY_COLORS[p], `Priority: ${name} (Houston)`]),
        ...KINDS.map((k) => [`kind:${k}`, KIND_COLORS[k], `Kind: ${k} (Houston)`]),
      ];
      for (const { repo } of teamRepos(team)) {
        for (const [name, color, description] of labels) gh.ensureLabel(repo, name, color, description);
        console.log(`${repo}: ${labels.length} labels in place`);
      }
      return;
    }
    const [target, ...changes] = args;
    if (!target || !changes.length) throw new HoustonError("Usage: houston labels owner/repo#12 status:in-progress [-p2]");
    const ref = parseRef(target);
    const p = writeLabels(team, ref, changes.filter((c) => !c.startsWith("-")), changes.filter((c) => c.startsWith("-")).map((c) => c.slice(1)));
    console.log(`${target}: ${[...p.add.map((l) => `+${l}`), ...p.remove.map((l) => `-${l}`)].join(" ") || "already like that"}`);
  },
} satisfies Command;
