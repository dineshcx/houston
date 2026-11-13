// houston trust: approve the current core. It's copied to .houston-local/core, and schedulers and run
// agents use that copy, because anyone who can push to the Houston repo could otherwise run code on
// the person's laptop.
import type { Command } from "../command";
import { coreHash, isTrusted, repoCoreVersion, trustCore } from "../lib/core";
import { paths } from "../lib/paths";
import { git } from "../lib/repo";
import { readState } from "../lib/state";

export default {
  summary: "Approve the current core for unattended runs, after reviewing a change",
  usage: "houston trust",
  run() {
    const version = repoCoreVersion();
    const before = readState().trusted_core;
    if (isTrusted()) return console.log(`Core ${version} is already trusted. Nothing changed.`);
    if (before && before !== coreHash()) {
      console.log(`Core ${version} has changed since you last trusted it. Recent changes to .houston/ and skills/run/:`);
      const log = git(["log", "--oneline", "-5", "--", ".houston", "skills/run"]).stdout;
      console.log(log ? log.replace(/^/gm, "  ") : "  (no commits; the change is uncommitted)");
      console.log(`Review them with \`git -C ${paths.root} log -p -- .houston skills/run\` and \`git -C ${paths.root} diff -- .houston skills/run\` if you haven't.`);
    } else console.log(`Trusting core ${version} on this machine.`);
    trustCore();
    console.log(`✓ Trusted core ${version}. Unattended runs use the copy in ${paths.trustedCore}.`);
  },
} satisfies Command;
