// houston page: make sure a cadence period's folder and people's page (_page.md) exist.
import { parseArgs } from "node:util";
import type { Command } from "../command";
import { atZoned, periodOf, zoned } from "../lib/cadence";
import { ensurePage, loadContext, openPeriods } from "../lib/draft";
import { commitAndPush } from "../lib/repo";
import { HoustonError } from "../lib/util";

/** Creates the pages for every cadence period open today; commits and pushes the new ones. */
export function ensureTodayPages(now = new Date()): string[] {
  const ctx = loadContext();
  return commitPages(openPeriods(ctx, Object.keys(ctx.team.projects), now).map((o) => ensurePage(o.project, o.cadence, o.period)), zoned(now, ctx.local.timezone).date);
}

function commitPages(created: (string | undefined)[], date: string): string[] {
  const files = created.filter((f): f is string => !!f);
  if (files.length) commitAndPush(files, `houston: pages for ${date}`);
  return files;
}

export default {
  summary: "Make sure a cadence period's page exists",
  usage: `houston page <project> <cadence> [--date YYYY-MM-DD]   the period containing that date (default today)
houston page --today                                  every cadence period open today`,
  run(args) {
    const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: { date: { type: "string" }, today: { type: "boolean" } } });
    if (values.today) {
      const files = ensureTodayPages();
      return console.log(files.length ? files.map((f) => `created ${f}`).join("\n") : "Today's pages already exist.");
    }
    const [project, name] = positionals;
    if (!project || !name) throw new HoustonError("Usage: houston page <project> <cadence> [--date YYYY-MM-DD], or houston page --today");
    const ctx = loadContext();
    const p = ctx.team.projects[project];
    if (!p) throw new HoustonError(`There is no project "${project}". Projects: ${Object.keys(ctx.team.projects).join(", ")}.`);
    const c = ctx.cadences[name];
    if (!c || !p.cadences.includes(name)) throw new HoustonError(`Project ${project} has no cadence "${name}". Its cadences: ${p.cadences.join(", ") || "none"}.`);
    const date = values.date ?? zoned(new Date(), ctx.local.timezone).date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(atZoned(date, "00:00", "UTC").getTime())) throw new HoustonError(`"${date}" isn't a date. Use YYYY-MM-DD.`);
    const period = periodOf(c, date);
    const files = commitPages([ensurePage(project, c, period)], date);
    console.log(files.length ? `created ${files[0]}` : `${project}/${name}/${period} already exists.`);
  },
} satisfies Command;
