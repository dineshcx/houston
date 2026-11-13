// houston trust: approve the current core. Unattended runs refuse a core the person hasn't approved,
// because anyone who can push to the Houston repo could otherwise run code on their laptop.
import type { Command } from "../command";
import { coreHash, trustCore } from "../lib/core";
import { coreVersion, paths } from "../lib/paths";
import { git } from "../lib/repo";
import { readState } from "../lib/state";

export default {
  summary: "Approve the current core for unattended runs, after reviewing a change",
  usage: "houston trust",
  async run() {
    const version = await coreVersion();
    const before = readState().trusted_core;
    if (before === coreHash()) return console.log(`Core ${version} is already trusted. Nothing changed.`);
    if (before) {
      console.log(`Core ${version} has changed since you last trusted it. Recent changes to .houston/:`);
      const log = git(["log", "--oneline", "-5", "--", ".houston"]).stdout;
      console.log(log ? log.replace(/^/gm, "  ") : "  (no commits; the change is uncommitted)");
      console.log(`Review them with \`git -C ${paths.root} log -p -- .houston\` if you haven't.`);
    } else console.log(`Trusting core ${version} for the first time on this machine.`);
    trustCore();
    console.log(`✓ Trusted core ${version}. Unattended runs will use it.`);
  },
} satisfies Command;
