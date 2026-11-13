// houston publish: approve the draft. Writes your files, applies the issue changes, commits and pushes.
import { parseArgs } from "node:util";
import type { Command } from "../command";
import { publishDraft } from "../lib/draft";

export default {
  summary: "Publish your run's draft",
  usage: `houston publish [--not-reviewed]

  --not-reviewed   mark your pages "not reviewed" (used when a draft publishes on its own)`,
  run(args) {
    const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: { "not-reviewed": { type: "boolean" } } });
    const done = publishDraft({ notReviewed: values["not-reviewed"] });
    console.log(["Published.", ...done.map((d) => `  - ${d}`)].join("\n"));
  },
} satisfies Command;
