// houston publish: approve the draft. Writes your files, commits and pushes them, then applies the issue changes.
import { parseArgs } from "node:util";
import type { Command } from "../command";
import { publishDraft } from "../lib/draft";
import { tryLock } from "../lib/state";
import { HoustonError } from "../lib/util";

export default {
  summary: "Publish your run's draft",
  usage: "houston publish",
  run(args) {
    parseArgs({ args, strict: true, allowPositionals: false, options: {} });
    const release = tryLock();
    if (!release) throw new HoustonError("A run is in progress right now. Try again in a minute.");
    try {
      const done = publishDraft();
      console.log(["Published.", ...done.map((d) => `  - ${d}`)].join("\n"));
    } finally {
      release();
    }
  },
} satisfies Command;
