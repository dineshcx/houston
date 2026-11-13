// houston skill: which SKILL.md to follow. A team's skills/<name>/ overrides the core's, so teams
// change how a workflow goes without forking Houston.
import { parseArgs } from "node:util";
import type { Command } from "../command";
import { skillNames, skillPath } from "../lib/setup";
import { HoustonError } from "../lib/util";

export default {
  summary: "Path of the skill to follow (the team's version wins), or list them",
  usage: "houston skill [<name>]\n\nWith a name, prints the SKILL.md to follow. Without one, lists every skill.",
  run(args) {
    const { positionals } = parseArgs({ args, strict: true, allowPositionals: true });
    const names = skillNames();
    if (!positionals[0]) {
      for (const n of names) {
        const s = skillPath(n)!;
        console.log(`${n.padEnd(16)} ${s.path}${s.overridden ? "  (team override)" : ""}`);
      }
      return;
    }
    const s = skillPath(positionals[0]);
    if (!s) throw new HoustonError(`There's no skill called "${positionals[0]}". Skills: ${names.join(", ")}.`);
    console.log(s.path);
  },
} satisfies Command;
