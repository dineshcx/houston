// houston apply: applies a merged intake proposal, change by change, through the shared issue rules.
// With a file it applies that proposal (anyone may); with --pending, every merged one this person owns.
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Command } from "../command";
import { loadTeam } from "../lib/config";
import { github } from "../lib/github";
import { paths } from "../lib/paths";
import { applyMergedProposals, applyProposal, assertOnDefaultBranch } from "../lib/proposals";
import { pull } from "../lib/repo";
import { HoustonError } from "../lib/util";

const usage = `
houston apply <proposal file>   apply one merged proposal, like proposals/2026-11-13-daily-sync.yml
houston apply --pending         apply every merged proposal you own that isn't applied yet
`;

/** Finds the proposal from a path or a bare name; an already-applied one resolves to proposals/applied/. */
function findProposal(arg: string): string {
  const name = basename(arg).replace(/(\.ya?ml)?$/, ".yml");
  const found = [resolve(arg), join(paths.root, arg), join(paths.proposals, name), join(paths.proposals, "applied", name)].find(existsSync);
  if (!found) throw new HoustonError(`There is no proposal ${arg}. Pending proposals are in ${paths.proposals}.`);
  return found;
}

export default {
  summary: "Apply a merged intake proposal, or all of yours with --pending",
  usage,
  run(args) {
    const { values, positionals } = parseArgs({ args, options: { pending: { type: "boolean" } }, strict: true, allowPositionals: true });
    if (positionals.length > 1 || (positionals.length === 1) === !!values.pending) throw new HoustonError(`Give one proposal file, or --pending.\n${usage}`);
    const team = loadTeam();
    const me = github().login();

    if (values.pending) {
      const lines = applyMergedProposals(team, me);
      console.log(lines.length ? lines.join("\n") : `No merged proposals waiting for @${me}.`);
      return;
    }
    const pulled = pull();
    if (!pulled.ok) throw new HoustonError(`Couldn't pull the Houston repo first: ${pulled.note}`);
    assertOnDefaultBranch();
    console.log(applyProposal(team, findProposal(positionals[0]), me));
  },
} satisfies Command;
