// houston skill: prints the skill an agent should follow, the team's own version when it has one,
// so a team can change how a workflow goes without forking Houston.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Command } from "../command";
import { paths } from "../lib/paths";
import { skillNames, skillPath } from "../lib/setup";
import { HoustonError } from "../lib/util";

export default {
  summary: "Print the skill to follow (the team's version wins), or list them",
  usage: `houston skill [<name>] [--path]

With a name, prints the skill's instructions to follow, after one line saying which file they
came from. Without one, lists every skill.

  --path   print only the path of the skill's SKILL.md`,
  run(args) {
    const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: { path: { type: "boolean" } } });
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
    if (values.path) return console.log(s.path);
    const source = s.overridden ? "team override" : s.path.startsWith(paths.teamSkills) ? "team" : "core";
    console.log(`(skill: ${s.path}, ${source})\n`);
    process.stdout.write(readFileSync(s.path, "utf8"));
  },
} satisfies Command;
