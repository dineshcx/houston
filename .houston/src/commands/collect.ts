// houston collect: gathers what the person did since their last published run, matched to issues.
import { parseArgs } from "node:util";
import type { Command } from "../command";
import { loadLocal, loadTeam } from "../lib/config";
import { writeDigest } from "../lib/evidence";
import { readState, windowStart } from "../lib/state";
import { UsageError } from "../lib/util";

export default {
  summary: "Gather your evidence since your last published run, matched to issues",
  usage: `houston collect [--since <ISO time>]

Prints the digest and writes it to .houston-local/digest.md.
  --since   start of the window (default: your last published run, or 24 hours ago)`,
  run(args) {
    const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: { since: { type: "string" } } });
    const now = new Date();
    const since = values.since ? new Date(values.since) : windowStart(readState(), now);
    if (isNaN(since.getTime())) throw new UsageError(`"${values.since}" isn't a time. Use an ISO time like 2026-11-13T06:00:00Z.`);
    console.log(writeDigest(loadTeam(), loadLocal(), since, now).text);
  },
} satisfies Command;
