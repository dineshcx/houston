// Core protection: anyone who can push to the Houston repo could otherwise run code on every
// teammate's laptop through their unattended runs. A run only executes a core the person approved.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { paths } from "./paths";
import { hash, readState, updateState } from "./state";

const SKIP = new Set(["node_modules", ".DS_Store", "test"]);

/** A hash over every file in .houston/ (tests and installed dev tools aside). */
export function coreHash(): string {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (SKIP.has(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(paths.core);
  return hash(files.map((f) => `${relative(paths.core, f)}\n${readFileSync(f, "utf8")}`).join("\n\0"));
}

export function isTrusted(): boolean {
  return readState().trusted_core === coreHash();
}

export function trustCore() {
  const h = coreHash();
  updateState((s) => (s.trusted_core = h));
  return h;
}
