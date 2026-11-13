// Core protection: anyone who can push to the Houston repo could otherwise run code on every
// teammate's laptop through their unattended runs. `houston trust` copies the reviewed core to
// .houston-local/core and schedulers and agents run that copy, so a `git pull` (even one in the
// middle of a run) can't bring in code that runs before the person has looked at it.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { paths } from "./paths";
import { hash, readState, updateState } from "./state";

/** Not part of what runs: installed dev tools, tests and docs. */
const SKIP = new Set(["node_modules", "test", "docs", ".DS_Store"]);

/** The team's own run skill: an unattended run follows it, so changing it needs approval too. */
const runSkillOverride = () => join(paths.teamSkills, "run", "SKILL.md");

/** Every file of the repo's core, relative to .houston/, with its bytes. Symlinks are left out. */
function coreFiles(): [string, Buffer][] {
  const out: [string, Buffer][] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(join(paths.repoCore, rel)).sort()) {
      if (SKIP.has(name)) continue;
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(paths.repoCore, r));
      if (st.isDirectory()) walk(r);
      else if (st.isFile()) out.push([r, readFileSync(join(paths.repoCore, r))]);
    }
  };
  if (existsSync(paths.repoCore)) walk("");
  return out;
}

function hashOf(files: [string, Buffer][]): string {
  const override = existsSync(runSkillOverride()) ? readFileSync(runSkillOverride(), "utf8") : "";
  return hash([...files.map(([f, b]) => `${f}\n${b.toString("base64")}`), `skills/run override\n${override}`].join("\n\0"));
}

/** A hash over the repo's .houston/ (tests, docs and installed dev tools aside) plus the team's run skill. */
export function coreHash(): string {
  return hashOf(coreFiles());
}

/** True when the repo's core is the one the person approved and its copy is in place. */
export function isTrusted(): boolean {
  return readState().trusted_core === coreHash() && existsSync(paths.bin);
}

/** The core version in the repo right now (the copy may be older). */
export function repoCoreVersion(): string {
  const f = join(paths.repoCore, "VERSION");
  return existsSync(f) ? readFileSync(f, "utf8").trim() : "0.0.0";
}

/** Approves the repo's core: copies it to .houston-local/core and records its hash. */
export function trustCore(): string {
  // Hash and copy the same bytes, so what's approved is exactly what runs.
  const files = coreFiles();
  const next = `${paths.trustedCore}.new`;
  rmSync(next, { recursive: true, force: true });
  mkdirSync(next, { recursive: true });
  for (const [rel, bytes] of files) {
    mkdirSync(dirname(join(next, rel)), { recursive: true });
    writeFileSync(join(next, rel), bytes, { mode: rel === "bin/houston" ? 0o755 : 0o644 });
  }
  rmSync(paths.trustedCore, { recursive: true, force: true });
  renameSync(next, paths.trustedCore);
  const h = hashOf(files);
  updateState((s) => (s.trusted_core = h));
  return h;
}
