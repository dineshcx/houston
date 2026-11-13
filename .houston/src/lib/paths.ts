// Where Houston's files are. Everything resolves from the Houston repo's main checkout.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { sh } from "./util";

/**
 * The Houston repo this CLI belongs to. HOUSTON_ROOT overrides it (tests, and running one
 * core against another checkout). Schedulers may start a run in a temporary git worktree,
 * where gitignored files like houston.local.yml don't exist, so we always resolve the main
 * checkout through git's common dir.
 */
function findRoot(): string {
  // From .houston/src/lib that's three levels up; from the trusted copy in .houston-local/core, four.
  const up = resolve(import.meta.dir, "../../..");
  const start = process.env.HOUSTON_ROOT ? resolve(process.env.HOUSTON_ROOT) : up.endsWith("/.houston-local") ? dirname(up) : up;
  const r = sh(["git", "-C", start, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (r.ok && r.stdout.endsWith("/.git")) return dirname(r.stdout);
  return start;
}

export const ROOT = findRoot();
export const CORE = resolve(import.meta.dir, "../..");

const LOCAL_DIR = join(ROOT, ".houston-local");

export const paths = {
  root: ROOT,
  core: CORE,
  team: join(ROOT, "houston.yml"),
  cadences: join(ROOT, "cadences"),
  projects: join(ROOT, "projects"),
  people: join(ROOT, "people"),
  proposals: join(ROOT, "proposals"),
  teamSkills: join(ROOT, "skills"),
  coreSkills: join(CORE, "skills"),
  presets: join(CORE, "presets"),
  version: join(CORE, "VERSION"),
  /** The core as committed in the repo, which `houston trust` copies from. */
  repoCore: join(ROOT, ".houston"),
  /** The CLI to give schedulers and agents: the trusted copy, so a pulled change can't run unreviewed. */
  bin: join(LOCAL_DIR, "core", "bin", "houston"),
  /** Personal and gitignored from here down. */
  local: join(ROOT, "houston.local.yml"),
  agentsLocal: join(ROOT, "AGENTS.local.md"),
  localDir: LOCAL_DIR,
  trustedCore: join(LOCAL_DIR, "core"),
  state: join(LOCAL_DIR, "state.json"),
  digest: join(LOCAL_DIR, "digest.md"),
  draft: join(LOCAL_DIR, "draft.md"),
};

/** Files Houston keeps in each linked code repo, hidden from git through .git/info/exclude. */
export const IN_CODE_REPO = { pointer: ".houston", inbox: ".houston-inbox.md" };

export const coreVersion = () => (existsSync(paths.version) ? Bun.file(paths.version).text() : Promise.resolve("0.0.0")).then((v) => v.trim());
