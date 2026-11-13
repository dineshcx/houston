// houston collect: gathers what the person did since their last published run, matched to issues.
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Command } from "../command";
import { loadLocal, loadTeam } from "../lib/config";
import { collect, renderDigest } from "../lib/evidence";
import { paths } from "../lib/paths";
import { readState } from "../lib/state";
import { HoustonError } from "../lib/util";

export default {
  summary: "Gather your evidence since your last published run, matched to issues",
  usage: `houston collect [--since <ISO time>] [--json]

Prints the digest and writes it to .houston-local/digest.md.
  --since   start of the window (default: your last published run, or 24 hours ago)
  --json    print the digest as JSON instead`,
  run(args) {
    const { values } = parseArgs({ args, strict: true, allowPositionals: true, options: { since: { type: "string" }, json: { type: "boolean" } } });
    const team = loadTeam();
    const local = loadLocal();
    const from = values.since ?? readState().last_publish;
    const since = from ? new Date(from) : new Date(Date.now() - 86_400_000);
    if (isNaN(since.getTime())) throw new HoustonError(`"${values.since}" isn't a time. Use an ISO time like 2026-11-13T06:00:00Z.`);
    const digest = collect(team, local, since);
    const text = renderDigest(digest, team);
    mkdirSync(paths.localDir, { recursive: true });
    writeFileSync(paths.digest, text);
    console.log(values.json ? JSON.stringify(digest, null, 2) : text);
  },
} satisfies Command;
