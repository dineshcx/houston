// houston page: make sure a cadence period's folder and people's page (_page.md) exist.
import { parseArgs } from "node:util";
import type { Command } from "../command";
import { cadenceOf, isDate, periodOf, zoned } from "../lib/cadence";
import { loadContext } from "../lib/config";
import { ensurePage } from "../lib/pages";
import { commitAndPush } from "../lib/repo";
import { UsageError } from "../lib/util";

export default {
  summary: "Make sure a cadence period's page exists",
  usage: `houston page <project> <cadence> [--date YYYY-MM-DD]   the period containing that date (default today)`,
  run(args) {
    const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: { date: { type: "string" } } });
    const [project, name, extra] = positionals;
    if (!project || !name || extra) throw new UsageError("Name a project and one of its cadences, like `houston page storefront daily`.");
    const ctx = loadContext();
    const c = cadenceOf(ctx.team, ctx.cadences, project, name);
    const date = values.date ?? zoned(new Date(), ctx.local.timezone).date;
    if (!isDate(date)) throw new UsageError(`"${date}" isn't a date. Use YYYY-MM-DD.`);
    const period = periodOf(c, date);
    const file = ensurePage(project, c, period);
    if (!file) return console.log(`${project}/${name}/${period} already exists.`);
    commitAndPush([file], `houston: ${project} ${name} page for ${period}`);
    console.log(`created ${file}`);
  },
} satisfies Command;
