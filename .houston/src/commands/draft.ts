// houston draft: show the run's draft, add or replace a section, hold it, release it or throw it away.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Command } from "../command";
import { zoned } from "../lib/cadence";
import { loadLocal } from "../lib/config";
import { addSection, discardDraft, draftStatus, KINDS, setHeld, type Kind } from "../lib/draft";
import { paths } from "../lib/paths";
import { HoustonError } from "../lib/util";

function show() {
  const st = draftStatus();
  if (!st) return console.log("No draft right now. `houston run` makes one when there's new work to report.");
  const tz = loadLocal().timezone;
  const when = st.held
    ? "It's on hold: it won't publish until you run `houston publish` (or `houston draft release`)."
    : st.deadline
      ? `It publishes on its own at ${zoned(st.deadline, tz).date} ${zoned(st.deadline, tz).time} (${tz}), marked "not reviewed".`
      : "It publishes when you run `houston publish`.";
  console.log(
    [
      `Your draft (${st.sections.length} section(s)${st.edited ? ", edited by you" : ""}). ${when}`,
      `Edit ${paths.draft} to change it, \`houston publish\` to approve it, \`houston draft hold\` to keep it back, \`houston draft discard\` to throw it away.`,
      "",
      st.text,
    ].join("\n"),
  );
}

export default {
  summary: "Show, add to, hold or discard your run's draft",
  usage: `houston draft                                         show the draft and when it publishes
houston draft add <kind> <target> [--file f]          add or replace a section (text from the file, or stdin)
houston draft hold | release | discard                keep it back / let it publish / throw it away

kinds and targets:
  day <YYYY-MM-DD>                       your day log
  page <project>/<cadence>/<period>      your section of an open cadence page
  summary <owner/repo#n>                 an issue's living summary (without the markers)
  labels <owner/repo#n>                  one label per line; -label removes it
  comment <owner/repo#n>                 a comment, when the team's rules allow it`,
  async run(args) {
    const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: { file: { type: "string" } } });
    const [action, kind, target, extra] = positionals;
    switch (action) {
      case undefined:
        return show();
      case "add": {
        if (!kind || !target || extra) throw new HoustonError("Usage: houston draft add <day|page|summary|labels|comment> <target> [--file f]");
        if (!KINDS.includes(kind as Kind)) throw new HoustonError(`"${kind}" isn't a draft section. Use one of: ${KINDS.join(", ")}.`);
        const body = values.file ? readFileSync(values.file, "utf8") : await Bun.stdin.text();
        addSection({ kind: kind as Kind, target, body: body.trim() });
        return console.log(`Added ${kind} ${target} to the draft.`);
      }
      case "hold":
        setHeld(true);
        return console.log("Held. The draft won't publish on its own; `houston publish` when it's ready, or `houston draft release`.");
      case "release":
        setHeld(false);
        return console.log("Released. The draft publishes at its deadline unless you publish it first.");
      case "discard":
        discardDraft();
        return console.log("Draft thrown away. The next run covers the same time again.");
      default:
        throw new HoustonError(`Unknown draft action "${action}". Use add, hold, release or discard.`);
    }
  },
} satisfies Command;
