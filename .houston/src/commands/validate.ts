// houston validate: checks houston.yml and every cadence file, listing every problem in plain words.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Command } from "../command";
import { parseCadence } from "../lib/cadence";
import { loadTeam } from "../lib/config";
import { paths } from "../lib/paths";

/** Every problem in houston.yml and cadences/, or none. */
export function problems(): string[] {
  const out: string[] = [];
  const files = existsSync(paths.cadences) ? readdirSync(paths.cadences).filter((f) => f.endsWith(".md")) : [];
  for (const f of files) {
    try {
      parseCadence(basename(f, ".md"), readFileSync(join(paths.cadences, f), "utf8"));
    } catch (e) {
      out.push((e as Error).message);
    }
  }
  try {
    // A broken cadence file still counts as existing, so it isn't reported twice.
    loadTeam(paths.team, files.map((f) => basename(f, ".md")));
  } catch (e) {
    out.push((e as Error).message);
  }
  return out;
}

export default {
  summary: "Check houston.yml and cadences/ and explain any problem",
  usage: "houston validate\n\nExits 1 if anything is wrong.",
  run() {
    const found = problems();
    if (!found.length) return console.log("✓ houston.yml and cadences/ are valid.");
    console.log(`✗ ${found.length} file(s) need fixing:\n\n${found.join("\n\n")}`);
    process.exit(1);
  },
} satisfies Command;
