// houston run: the unattended loop. Collects what the person did, has a small model draft their
// updates through `houston draft add`, and publishes or waits for review per the team's rules.
// The agent can only run the trusted copy of the CLI, which checks everything; it only decides what to say.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Command } from "../command";
import { DAY_NAMES, splitFrontMatter, zoned } from "../lib/cadence";
import { loadContext, type Context } from "../lib/config";
import { isTrusted, repoCoreVersion } from "../lib/core";
import { discardDraft, draftStatus, publishDraft, setHeld, startDraft } from "../lib/draft";
import { isQuiet, writeDigest } from "../lib/evidence";
import { dayLogFile, ensureTodayPages, myProjects, openPeriods, pageFile, stripFooter } from "../lib/pages";
import { paths } from "../lib/paths";
import { applyMergedProposals } from "../lib/proposals";
import { pull } from "../lib/repo";
import { readState, tryLock, updateState, windowStart, type State } from "../lib/state";
import { HoustonError, clip, iso, parseDuration, sh } from "../lib/util";

const AGENT_TIMEOUT_MS = 10 * 60_000;

/** The run skill's instructions: the team's own skills/run/SKILL.md wins over core's. */
function runSkill(): string {
  const file = [join(paths.teamSkills, "run", "SKILL.md"), join(paths.coreSkills, "run", "SKILL.md")].find(existsSync);
  if (!file) throw new HoustonError("The run skill (.houston/skills/run/SKILL.md) is missing. Restore it with `git checkout .houston`, then run `houston trust`.");
  return splitFrontMatter(readFileSync(file, "utf8")).body.trim();
}

const current = (file: string) => (existsSync(file) ? stripFooter(readFileSync(file, "utf8")) : "") || "(empty)";

/** Everything the agent needs, in one prompt: the skill, the facts of this run, the files to merge into, the digest. */
function prompt(ctx: Context, digest: string, now: Date): string {
  const { team, local } = ctx;
  const z = zoned(now, local.timezone);
  const r = team.rules;
  const out = [
    runSkill(),
    "",
    "---",
    "",
    "# This run",
    `- Person: @${local.user}. Today is ${DAY_NAMES[z.weekday]} ${z.date}, ${z.time} in ${local.timezone}.`,
    `- The houston command is \`${paths.bin}\`. Always call it by this exact path.`,
    `- Status labels: ${r.status === "never" ? "do not change them" : team.status.columns.map((c) => `status:${c.label} (${c.name})`).join(", ")}.`,
    `- Other labels (priority, kind): ${r.labels === "never" ? "do not change them" : "allowed"}.`,
    `- Living summaries on issues: ${r.summary_on_issue ? "yes" : "no, don't write summary sections"}.`,
    `- Comments: ${{ none: "never comment", blockers_only: "only to say an issue is blocked, and on what", summary_changes: "a short note when a summary changed" }[r.issue_comment]}.`,
    "",
    "# Sections to write",
    "",
    `## day ${z.date}`,
    `Your day log. Current content, merge into it:`,
    `<current>\n${current(dayLogFile(local.user, z.date))}\n</current>`,
  ];
  for (const o of openPeriods(ctx, myProjects(team, local), now).filter((o) => o.cadence.writers.includes("runs"))) {
    out.push(
      "",
      `## page ${o.target}`,
      `${o.cadence.title} for ${team.projects[o.project].name}. Follow this template:`,
      `<template>\n${o.cadence.template || "## Done\n## Doing\n## Blocked\n## Other"}\n</template>`,
      "Current content, merge into it:",
      `<current>\n${current(pageFile(o.target, local.user))}\n</current>`,
    );
  }
  out.push("", "# Digest", "", digest);
  return out.join("\n");
}

/**
 * Starts the agent, locked down: only the Bash tool, only `houston draft add` and `houston issues`
 * from the trusted copy, no MCP servers, and none of the person's or the repo's settings (their
 * allow rules and hooks don't apply). Anything else is denied without asking. It runs in an empty
 * folder so no repo instructions load. HOUSTON_AGENT replaces `claude` (tests); the prompt is on stdin.
 */
function startAgent(ctx: Context, text: string): { ok: boolean; note: string } {
  const custom = process.env.HOUSTON_AGENT;
  const cmd = custom
    ? ["sh", "-c", custom]
    : [
        "claude", "-p",
        "--model", ctx.team.runs.model,
        "--max-turns", String(ctx.team.runs.max_turns),
        "--no-session-persistence",
        "--tools", "Bash",
        "--allowedTools", `Bash(${paths.bin} draft add:*)`, `Bash(${paths.bin} issues:*)`,
        "--setting-sources", "",
        "--strict-mcp-config",
        "--permission-mode", "dontAsk",
      ];
  const cwd = mkdtempSync(join(tmpdir(), "houston-run-"));
  let p: ReturnType<typeof Bun.spawnSync>;
  try {
    p = Bun.spawnSync(cmd, { cwd, stdin: new TextEncoder().encode(text), env: { ...process.env, HOUSTON_BIN: paths.bin, HOUSTON_IN_RUN: "1" }, stdout: "pipe", stderr: "pipe", timeout: AGENT_TIMEOUT_MS });
  } catch {
    throw new HoustonError("Couldn't start Claude Code (`claude`). Install it, or check it's on the PATH your scheduler uses.");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  const err = `${p.stderr?.toString() ?? ""}\n${p.stdout?.toString() ?? ""}`.trim();
  return p.exitCode === 0 ? { ok: true, note: "" } : { ok: false, note: clip(err || `exit ${p.exitCode ?? "timeout"}`, 300) };
}

function notify(message: string) {
  if (process.platform !== "darwin" || process.env.HOUSTON_NO_NOTIFY) return;
  sh(["osascript", "-e", `display notification ${JSON.stringify(clip(message, 200))} with title "Houston"`]);
}

function record(outcome: NonNullable<State["last_run"]>["outcome"], now: Date, extra: { note?: string; sources?: Record<string, string> } = {}) {
  updateState((s) => (s.last_run = { at: iso(now), outcome, ...extra }));
}

/** "09:45", or "09:45 on 2026-11-12" when it isn't today. */
function at(d: Date, now: Date, tz: string) {
  const z = zoned(d, tz);
  return z.date === zoned(now, tz).date ? z.time : `${z.time} on ${z.date}`;
}

/**
 * Publishes the draft. If that fails, the draft is held and the failure recorded, so the run
 * carries on (the held draft waits for the person) instead of failing the same way every time.
 * Returns why it failed, or undefined.
 */
function publishOrHold(now: Date, notReviewed: boolean): string | undefined {
  try {
    publishDraft({ notReviewed, now });
    return undefined;
  } catch (e) {
    if (!(e instanceof HoustonError)) throw e;
    const reason = e.message.trim().replace(/\.$/, "");
    setHeld(true);
    record("failed", now, { note: clip(`couldn't publish: ${reason}`, 300) });
    const message = `Couldn't publish your draft: ${reason}. Fix it with \`houston draft\`, or \`houston draft discard\`.`;
    notify(message);
    return message;
  }
}

function untrustedCore(): HoustonError {
  if (!readState().trusted_core || !existsSync(paths.bin)) return new HoustonError("Houston isn't set up on this machine yet: say 'set me up' or run `houston trust`.");
  return new HoustonError(
    `Houston's core changed since you approved it (it's version ${repoCoreVersion()} now), so it won't run unattended. ` +
      `Review the change with \`git -C ${paths.root} log -p -- .houston skills/run\` (and \`git -C ${paths.root} diff -- .houston skills/run\` for uncommitted changes), then run \`houston trust\`.`,
  );
}

function runOnce(values: { "if-due"?: boolean }, say: (msg: string, needsYou?: boolean) => void) {
  const now = new Date();
  const pulled = pull();
  if (!pulled.ok) say(`Couldn't pull the Houston repo (${clip(pulled.note, 200)}); carrying on with what's here.`);
  // The pull may have brought a new core or run skill: stop before anything else uses it.
  if (!isTrusted()) {
    notify("Houston's core changed. Review it and run `houston trust`.");
    throw untrustedCore();
  }
  const ctx = loadContext();
  const { team, local } = ctx;
  for (const line of applyMergedProposals(team, local.user)) say(line);

  const last = readState().last_run;
  // A draft past its deadline publishes first, so a late laptop still makes standup.
  let draft = draftStatus();
  let publishFailed = false;
  if (draft && !draft.held && draft.deadline && draft.deadline <= now) {
    const failure = publishOrHold(now, !draft.edited);
    if (failure) {
      publishFailed = true;
      say(failure, true);
    } else say(`Published your updates (${draft.edited ? "as you left them" : "not reviewed"}: the ${at(draft.deadline, now, local.timezone)} deadline had passed).`);
    draft = draftStatus();
  }

  if (values["if-due"] && last && now.getTime() - Date.parse(last.at) < parseDuration(team.runs.every)) return;

  if (draft && (draft.edited || draft.held)) {
    if (!publishFailed) record("waiting", now, { note: draft.held ? "draft held" : "draft edited" });
    return say(`Your draft is waiting for you (${draft.held ? "held" : "you edited it"}). \`houston draft\` to see it, \`houston publish\` to publish it.`, true);
  }

  try {
    ensureTodayPages(ctx, now);
  } catch (e) {
    say(`Couldn't create today's pages: ${(e as Error).message}`);
  }
  const since = windowStart(readState(), now);
  const { digest, text } = writeDigest(team, local, since, now);
  if (isQuiet(digest)) {
    record("quiet", now, { sources: digest.sources });
    return say(`Nothing new since ${at(since, now, local.timezone)}.`);
  }

  startDraft(ctx, { start: since, end: now }, digest.sources, digest.inbox, now);
  const agent = startAgent(ctx, prompt(ctx, text, now));
  if (!agent.ok) {
    discardDraft();
    record("failed", now, { note: agent.note, sources: digest.sources });
    throw new HoustonError(`The run's agent failed, so nothing was drafted; the next run covers this time again.\n${agent.note}`);
  }
  draft = draftStatus();
  if (!draft?.sections.length) {
    discardDraft();
    record("quiet", now, { note: "the agent found nothing to write", sources: digest.sources });
    return say("The agent found nothing worth writing.");
  }

  const pastDeadline = draft.deadline && draft.deadline <= now;
  if (team.rules.publish_runs === "auto" || pastDeadline) {
    const failure = publishOrHold(now, true);
    if (failure) return say(failure, true);
    return say(pastDeadline ? `Published your updates (not reviewed: the ${at(draft.deadline!, now, local.timezone)} deadline had passed).` : "Published your updates.");
  }
  record("drafted", now, { sources: digest.sources });
  const when = draft.deadline ? `It publishes on its own at ${at(draft.deadline, now, local.timezone)} unless you approve or hold it.` : "It publishes when you approve it.";
  notify("Your Houston draft is ready to review.");
  say(`Your draft is ready. ${when}\n\`houston draft\` to read it, \`houston publish\` to approve, \`houston draft hold\` to keep it back.`, true);
}

export default {
  summary: "Collect your work, draft your updates, publish per the team's rules",
  usage: `houston run [--if-due] [--quiet]

  --if-due   do nothing if the last run was less than runs.every ago
  --quiet    print only when something needs you`,
  run(args) {
    const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: { "if-due": { type: "boolean" }, quiet: { type: "boolean" } } });
    const say = (msg: string, needsYou = false) => {
      if (needsYou || !values.quiet) console.log(msg);
    };
    loadContext(); // no houston.yml yet: tell the person to set up, before anything else
    if (!isTrusted()) throw untrustedCore();
    const release = tryLock();
    if (!release) return say("Another Houston run is in progress; leaving it to finish.");
    try {
      runOnce(values, say);
    } finally {
      release();
    }
  },
} satisfies Command;
