// houston summary: print or replace an issue's living summary (interactive use; runs use the draft).
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Command } from "../command";
import { loadTeam } from "../lib/config";
import { github, parseRef } from "../lib/github";
import { assertTeamRepo, readSummary, writeSummary } from "../lib/issues";
import { HoustonError, UsageError } from "../lib/util";

export default {
  summary: "Print or replace an issue's living summary",
  usage: `houston summary <owner/repo#n>                    print the summary
houston summary <owner/repo#n> --set [--file f]   replace it with the file's text (or stdin)`,
  async run(args) {
    const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: { set: { type: "boolean" }, file: { type: "string" } } });
    if (positionals.length !== 1) throw new UsageError("Name one issue, like `houston summary acme/web#12`.");
    const team = loadTeam();
    const ref = parseRef(positionals[0]);
    assertTeamRepo(team, ref.repo);
    if (!values.set) return console.log(readSummary(github().issue(ref).body) ?? `${positionals[0]} has no living summary yet.`);
    const text = values.file ? readFileSync(values.file, "utf8") : await Bun.stdin.text();
    if (!text.trim()) throw new HoustonError("The new summary is empty; nothing changed.");
    console.log(writeSummary(team, ref, text).note);
  },
} satisfies Command;
