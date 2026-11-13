// houston doctor: one line per check, with a fix for each problem. Exit 1 if anything failed.
// Checks that need GitHub turn into warnings when it can't be reached, so a laptop on a train
// isn't told its setup is broken.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "../command";
import { formatAt } from "../lib/cadence";
import { loadLocal, loadTeam, teamRepos, type Local, type Team } from "../lib/config";
import { isTrusted, repoCoreVersion } from "../lib/core";
import { github } from "../lib/github";
import { IN_CODE_REPO, paths } from "../lib/paths";
import { originOf } from "../lib/repo";
import { BLOCK_BEGIN, blockRoots, excludeFile, globalFile, houstonRoot, systemTimezone } from "../lib/setup";
import { readState } from "../lib/state";
import { parseDuration, sh } from "../lib/util";
import { problems } from "./validate";

type Mark = "ok" | "fail" | "warn";
const lines: { mark: Mark; text: string; fix?: string }[] = [];
const check = (mark: Mark, text: string, fix?: string) => lines.push({ mark, text, fix });
const ago = (ms: number) => (ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 3_600_000)}h`);

function tools() {
  check(sh(["git", "--version"]).ok ? "ok" : "fail", "git", "Install git: https://git-scm.com");
  check(Bun.which("bun") ? "ok" : "fail", "bun on PATH", "Install Bun (https://bun.sh) so schedulers can start `houston run`.");
  check(Bun.which("claude") ? "ok" : "fail", "claude on PATH", "Install Claude Code (https://claude.com/claude-code); runs start it headless.");
}

/** The signed-in GitHub user, or undefined when GitHub can't be reached. */
function login(): string | undefined {
  if (!process.env.HOUSTON_FAKE_GITHUB && !Bun.which("gh")) return check("fail", "gh installed", "Install the GitHub CLI: https://cli.github.com"), undefined;
  try {
    const me = github().login();
    check("ok", `gh signed in as ${me}`);
    return me;
  } catch {
    // `gh auth token` reads the local login without the network, so it tells offline from signed out.
    if (sh(["gh", "auth", "token"]).ok) check("warn", "couldn't reach GitHub; checks that need it are skipped", "Try again when you're online.");
    else check("fail", "gh signed in", "Run `gh auth login`.");
  }
}

function localFile(): Local | undefined {
  if (!existsSync(paths.local)) return void check("fail", "no houston.local.yml yet", "Run `houston link`.");
  try {
    const local = loadLocal();
    check("ok", "houston.local.yml is valid");
    return local;
  } catch (e) {
    check("fail", (e as Error).message.replace(/\n/g, "\n    "), "Fix it, or run `houston link` to write it again.");
  }
}

function linkedRepos(team: Team, local: Local) {
  for (const { repo } of teamRepos(team)) {
    const dir = local.repos[repo];
    const relink = `Run \`houston link\` (or \`houston link --repo ${repo}=/path\`, or \`=none\` if it isn't on this machine).`;
    if (dir === null) check("ok", `${repo}: not on this machine`);
    else if (!dir) check("fail", `${repo}: not linked`, relink);
    else if (!existsSync(dir)) check("fail", `${repo}: ${dir} doesn't exist`, relink);
    else if (originOf(dir)?.toLowerCase() !== repo.toLowerCase()) check("fail", `${repo}: ${dir} is a clone of ${originOf(dir) ?? "nothing on GitHub"}`, relink);
    else {
      const files = [IN_CODE_REPO.pointer, IN_CODE_REPO.inbox];
      const exclude = existsSync(excludeFile(dir)) ? readFileSync(excludeFile(dir), "utf8").split("\n").map((l) => l.trim()) : [];
      const bad = files.filter((f) => !existsSync(join(dir, f)) || !exclude.includes(f));
      check(bad.length ? "fail" : "ok", `${repo}: linked at ${dir}${bad.length ? `, but ${bad.join(" and ")} missing or not hidden from git` : ""}`, "Run `houston link`.");
    }
  }
}

/** A missing block is only a warning: someone who linked with --no-global keeps their own instructions. */
function globalBlock() {
  const text = existsSync(globalFile()) ? readFileSync(globalFile(), "utf8") : "";
  if (blockRoots(text).includes(houstonRoot())) return check("ok", `the Houston block in ${globalFile()} lists this repo`);
  const what = text.includes(BLOCK_BEGIN) ? `the Houston block in ${globalFile()} doesn't list this repo` : `no Houston block in ${globalFile()}`;
  check("warn", `${what}, so your agent won't catch up missed runs here`, "Run `houston link` (skip this if you chose --no-global).");
}

/** Same wording as `houston trust`: trusting for the first time is routine; a changed core needs a review first. */
async function trust() {
  const version = repoCoreVersion();
  if (isTrusted()) check("ok", `core ${version} is trusted for unattended runs`);
  else if (!readState().trusted_core) check("fail", `core ${version} isn't trusted on this machine yet`, "Run `houston link` (or `houston trust`).");
  else check("fail", `core ${version} has changed since you last trusted it, so runs won't start`, `Review the change with \`git -C ${paths.root} log -p -- .houston skills/run\` (and \`git diff\` for uncommitted changes), then run \`houston trust\`.`);
}

function runs(team: Team, tz: string) {
  const s = readState();
  const now = Date.now();
  if (!s.last_run) check("warn", "no run yet", "Run `houston run` once to see it work.");
  else {
    const age = now - Date.parse(s.last_run.at);
    const note = `last run ${formatAt(s.last_run.at, tz)}, ${ago(age)} ago (${s.last_run.outcome}${s.last_run.note ? `: ${s.last_run.note}` : ""})`;
    if (s.last_run.outcome === "failed") check("fail", note, "Run `houston run` to see the error.");
    else if (age > 2 * parseDuration(team.runs.every)) check("warn", `${note}; runs.every is ${team.runs.every}`, "Check that your scheduler is running `houston run` (see `houston schedule`).");
    else check("ok", note);
  }
  if (!s.draft) check("ok", "no draft waiting");
  else {
    const when = s.draft.held || !s.draft.deadline ? "waits for you" : `publishes ${formatAt(s.draft.deadline, tz)}`;
    check("warn", `a draft is waiting${s.draft.held ? " (held)" : ""}; it ${when}`, "Read it with `houston draft`, then `houston publish`, `houston draft hold` or edit it.");
  }
}

export default {
  summary: "Check this machine's setup and say how to fix each problem",
  usage: "houston doctor\n\nExits 1 if any check fails.",
  async run() {
    const fresh = !existsSync(paths.team);
    if (fresh) check("fail", `this Houston repo isn't set up yet: say "set me up" to your agent here (${paths.root})`);
    tools();
    const me = login();

    let team: Team | undefined;
    if (!fresh) {
      const found = problems();
      check(found.length ? "fail" : "ok", "houston.yml and cadences/ are valid", "Run `houston validate` to see the problems.");
      if (!found.length) team = loadTeam();
    }
    const local = localFile();

    if (team) {
      const who = me ?? local?.user;
      if (who) check(team.team.members.includes(who) ? "ok" : "fail", `${who} is in team.members`, "Ask a lead to add you to team.members in houston.yml.");
      if (local) linkedRepos(team, local);
      const version = repoCoreVersion();
      check(version === team.core ? "ok" : "fail", `core ${version} matches core: ${team.core} in houston.yml`, "Run `houston update`, or `git pull` if a teammate already updated the core.");
    }

    globalBlock();
    await trust();
    if (team) runs(team, local?.timezone ?? systemTimezone());
    check(local?.schedule ? "ok" : "fail", local?.schedule ? `schedule: ${local.schedule}` : "no schedule recorded", "Run `houston schedule`, set it up in your scheduler, then record it with `houston schedule --set \"…\"`.");

    for (const l of lines) console.log(`${{ ok: "✓", fail: "✗", warn: "!" }[l.mark]} ${l.text}${l.mark !== "ok" && l.fix ? ` — ${l.fix}` : ""}`);
    if (lines.some((l) => l.mark === "fail")) process.exit(1);
  },
} satisfies Command;
