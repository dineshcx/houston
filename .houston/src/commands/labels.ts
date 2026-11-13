// houston labels: change an issue's labels under the team's rules, or create the core labels everywhere.
import type { Command } from "../command";
import { loadTeam, teamRepos } from "../lib/config";
import { github, parseRef } from "../lib/github";
import { coreLabels, writeLabels } from "../lib/issues";
import { UsageError } from "../lib/util";

export default {
  summary: "Change an issue's labels, or create the core labels in every team repo",
  usage: `houston labels <owner/repo#n> <label>… [-<label>]…   add labels; -label removes one
houston labels sync                                   create the status, priority and kind labels in every team repo`,
  run(args) {
    // Not parseArgs: "-status:todo" means "remove this label", which parseArgs would read as an option.
    const team = loadTeam();
    if (args[0] === "sync" && args.length === 1) {
      const gh = github();
      const labels = coreLabels(team);
      for (const { repo } of teamRepos(team)) {
        for (const l of labels) gh.ensureLabel(repo, l.name, l.color, l.description);
        console.log(`${repo}: ${labels.length} labels in place`);
      }
      return;
    }
    const [target, ...changes] = args;
    if (!target || !changes.length) throw new UsageError("Name an issue and the labels, like `houston labels owner/repo#12 status:in-progress -p2`.");
    const p = writeLabels(team, parseRef(target), changes.filter((c) => !c.startsWith("-")), changes.filter((c) => c.startsWith("-")).map((c) => c.slice(1)));
    console.log(`${target}: ${[...p.add.map((l) => `+${l}`), ...p.remove.map((l) => `-${l}`)].join(" ") || "already like that"}`);
  },
} satisfies Command;
