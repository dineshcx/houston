// houston schedule: Houston doesn't install schedules. It gives the person one instruction to put in
// whatever scheduler they use, the times their cadences need, and records which scheduler they chose.
import { existsSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import type { Command } from "../command";
import { loadCadences } from "../lib/cadence";
import { loadLocal, loadTeam } from "../lib/config";
import { paths } from "../lib/paths";
import { cronLines, daysInWords, houstonRoot, instruction, localText, readLocalRaw, suggestRuns, systemTimezone, trustedBin } from "../lib/setup";
import { HoustonError, UsageError } from "../lib/util";

/** Cron starts jobs with a bare PATH, so the crontab line carries the folders of the tools a run needs. */
function cronPath(): string {
  const dirs = ["bun", "claude", "gh", "git"].map((t) => Bun.which(t)).filter((p): p is string => !!p).map(dirname);
  return [...new Set([...dirs, "/usr/bin", "/bin"])].join(":");
}

export default {
  summary: "Show the one instruction to schedule and when; record which scheduler you used",
  usage: `
houston schedule [--set "<sentence>"]

Prints \`houston run\` as your scheduler should run it (the copy of the core you trusted), with
suggested times from your team's cadences in your timezone. Houston doesn't install schedules;
use any scheduler you like.

  --set "<sentence>"   record which scheduler runs it, its name and when, in houston.local.yml
                       (e.g. "crontab, Mon–Fri 09:00, 09:45, 12:00, 15:00, 18:00")`,
  run(args) {
    const { values } = parseArgs({ args, strict: true, allowPositionals: true, options: { set: { type: "string" } } });
    if (values.set !== undefined) {
      if (!existsSync(paths.local)) throw new HoustonError("No houston.local.yml yet. Run `houston link` first.");
      if (!values.set.trim()) throw new UsageError('Say which scheduler runs it and when, e.g. --set "crontab, Mon–Fri 09:00 and every 3h".');
      writeFileSync(paths.local, localText({ ...readLocalRaw(), schedule: values.set.trim() }));
      return console.log(`Recorded: ${values.set.trim()}\nTo change or stop it later, use the same scheduler, then run this again.`);
    }

    const team = loadTeam();
    const local = loadLocal();
    const all = loadCadences();
    const used = [...new Set(Object.values(team.projects).flatMap((p) => p.cadences))].map((n) => all[n]).filter(Boolean);
    const suggested = suggestRuns(used, team);
    const cmd = instruction();

    console.log(`Your scheduler needs to run one instruction, on this machine (not in the cloud):\n\n  ${cmd}\n`);
    console.log(`Suggested times (${local.timezone}):`);
    for (const r of suggested) console.log(`  ${daysInWords(r.days).padEnd(14)} ${r.time}  ${r.why.join("; ")}`);
    console.log("\nExtra runs are safe: each run only adds what's new since the last one.\n");

    const sys = systemTimezone();
    console.log(`Example 1, crontab (\`crontab -e\`). Cron uses this machine's timezone (${sys})${sys !== local.timezone ? `, not ${local.timezone}: shift the hours to match` : ""}:\n`);
    for (const line of cronLines(suggested, `cd ${houstonRoot()} && PATH=${cronPath()} ${trustedBin()} run`)) console.log(`  ${line}`);
    const byDays = new Map<string, string[]>();
    for (const r of suggested) byDays.set(daysInWords(r.days), [...(byDays.get(daysInWords(r.days)) ?? []), r.time]);
    const when = [...byDays].map(([days, times]) => `${times.join(", ")} on ${days}`).join("; and ");
    console.log(`\nExample 2, an agent app's scheduled task. Tell it:\n`);
    console.log(`  "Create a scheduled task that runs on this machine, not in the cloud, at ${when} (${local.timezone}). It runs this in a terminal and does nothing else: ${cmd}"\n`);
    console.log(local.schedule ? `Recorded schedule: ${local.schedule}` : 'Once it\'s set up, record it: houston schedule --set "<scheduler, task name, when>"');
  },
} satisfies Command;
