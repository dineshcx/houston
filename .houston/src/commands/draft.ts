// houston draft: show the run's draft, add or replace a section, hold it, release it or throw it away.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Command } from "../command";
import { formatAt } from "../lib/cadence";
import { loadLocal } from "../lib/config";
import { addSection, discardDraft, draftStatus, SECTION_KINDS, setHeld, type Kind } from "../lib/draft";
import { paths } from "../lib/paths";
import { HoustonError, UsageError } from "../lib/util";

function show() {
  const st = draftStatus();
  if (!st) return console.log("No draft right now. `houston run` makes one when there's new work to report.");
  const tz = loadLocal().timezone;
  const when = st.held
    ? "It's on hold: it won't publish until you run `houston publish` (or `houston draft release`)."
    : !st.deadline
      ? "It publishes when you run `houston publish`."
      : st.edited
        ? `You've edited it, so it publishes on its own at ${formatAt(st.deadline, tz)} (${tz}) as you left it.`
        : `It publishes on its own at ${formatAt(st.deadline, tz)} (${tz}), marked "not reviewed".`;
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
  day <YYYY-MM-DD>                       your day log (a date in the draft's window)
  page <project>/<cadence>/<period>      your section of an open cadence page
  summary <owner/repo#n>                 an issue's living summary (without the markers)
  labels <owner/repo#n>                  one label per line; -label removes it
  comment <owner/repo#n>                 a comment, when the team's rules allow it`,
  async run(args) {
    const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: { file: { type: "string" } } });
    const [action, kind, target, extra] = positionals;
    if (action !== "add" && (kind || values.file)) throw new UsageError(`\`houston draft ${action ?? ""}\` takes no other arguments.`);
    switch (action) {
      case undefined:
        return show();
      case "add": {
        if (!kind || !target || extra) throw new UsageError("Say which section: houston draft add <day|page|summary|labels|comment> <target>, with the text on stdin.");
        if (!SECTION_KINDS.includes(kind as Kind)) throw new UsageError(`"${kind}" isn't a draft section. Use one of: ${SECTION_KINDS.join(", ")}.`);
        // During a run the agent may only pass text on stdin, so it can't make Houston read other files.
        const inRun = !!process.env.HOUSTON_IN_RUN;
        if (inRun && values.file) throw new HoustonError("During a run, pass the section's text on stdin, not with --file.");
        const body = values.file ? readFileSync(values.file, "utf8") : await Bun.stdin.text();
        addSection({ kind: kind as Kind, target, body: body.trim() }, { byPerson: !inRun });
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
        throw new UsageError(`Unknown draft action "${action}". Use add, hold, release or discard.`);
    }
  },
} satisfies Command;
