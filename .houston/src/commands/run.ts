// houston run: the unattended loop. Collects what the person did, has a small model draft their
// updates through `houston draft`, and publishes or waits for review per the team's rules.
// Everything the agent may do is checked by the CLI; the agent only decides what to say.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Command } from "../command";
import { splitFrontMatter, zoned } from "../lib/cadence";
import { isTrusted } from "../lib/core";
import { dayLogFile, discardDraft, draftStatus, loadContext, myProjects, openPeriods, pageFile, publishDraft, startDraft, stripFooter, type Context } from "../lib/draft";
import { collect, isQuiet, renderDigest } from "../lib/evidence";
import { paths } from "../lib/paths";
import { applyMergedProposals } from "../lib/proposals";
import { pull } from "../lib/repo";
import { readState, updateState, type State } from "../lib/state";
import { HoustonError, clip, iso, parseDuration, sh } from "../lib/util";
import { ensureTodayPages } from "./page";

const BIN = join(paths.core, "bin", "houston");
const AGENT_TIMEOUT_MS = 10 * 60_000;
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The run skill's instructions: the team's own skills/run/SKILL.md wins over core's. */
function runSkill(): string {
  const file = [join(paths.teamSkills, "run", "SKILL.md"), join(paths.coreSkills, "run", "SKILL.md")].find(existsSync);
  if (!file) throw new HoustonError("The run skill (.houston/skills/run/SKILL.md) is missing. Restore it with `git checkout .houston`.");
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
    `- The houston command is \`${BIN}\`. Always call it by this exact path.`,
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

/** Starts the agent. HOUSTON_AGENT replaces `claude` (tests); it gets the prompt on stdin either way. */
function startAgent(ctx: Context, text: string): { ok: boolean; note: string } {
  const custom = process.env.HOUSTON_AGENT;
  const cmd = custom
    ? ["sh", "-c", custom]
    : ["claude", "-p", "--model", ctx.team.runs.model, "--max-turns", String(ctx.team.runs.max_turns), "--no-session-persistence", "--allowedTools", `Bash(${BIN} draft:*)`, `Bash(${BIN} issues:*)`, "Read"];
  let p: ReturnType<typeof Bun.spawnSync>;
  try {
    p = Bun.spawnSync(cmd, { cwd: paths.root, stdin: new TextEncoder().encode(text), env: { ...process.env, HOUSTON_BIN: BIN }, stdout: "pipe", stderr: "pipe", timeout: AGENT_TIMEOUT_MS });
  } catch {
    throw new HoustonError("Couldn't start Claude Code (`claude`). Install it, or check it's on the PATH your scheduler uses.");
  }
  const err = `${p.stderr?.toString() ?? ""}\n${p.stdout?.toString() ?? ""}`.trim();
  return p.exitCode === 0 ? { ok: true, note: "" } : { ok: false, note: clip(err || `exit ${p.exitCode ?? "timeout"}`, 300) };
}

function notify(message: string) {
  if (process.platform !== "darwin" || process.env.HOUSTON_NO_NOTIFY) return;
  sh(["osascript", "-e", `display notification ${JSON.stringify(message)} with title "Houston"`]);
}

function record(outcome: NonNullable<State["last_run"]>["outcome"], now: Date, extra: { note?: string; sources?: Record<string, string> } = {}) {
  updateState((s) => (s.last_run = { at: iso(now), outcome, ...extra }));
}

const at = (d: Date, tz: string) => `${zoned(d, tz).time}${zoned(d, tz).date === zoned(new Date(), tz).date ? "" : ` on ${zoned(d, tz).date}`}`;

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
    const now = new Date();

    if (!isTrusted())
      throw new HoustonError(`Houston's core (.houston/) changed since you last approved it, so it won't run unattended. Review the change with \`git -C ${paths.root} log -p .houston\`, then run \`houston trust\`.`);
    const pulled = pull();
    if (!pulled.ok) say(`Couldn't pull the Houston repo (${clip(pulled.note, 200)}); carrying on with what's here.`);
    const ctx = loadContext();
    const { team, local } = ctx;
    for (const line of applyMergedProposals(team, local.user)) say(line);

    const last = readState().last_run;
    // A draft past its deadline publishes first, so a late laptop still makes standup.
    let draft = draftStatus();
    if (draft && !draft.held && draft.deadline && draft.deadline <= now) {
      publishDraft({ notReviewed: !draft.edited, now });
      say(`Published your draft: its deadline passed${draft.edited ? "" : ' (marked "not reviewed")'}.`);
      draft = undefined;
    }

    if (values["if-due"] && last && now.getTime() - Date.parse(last.at) < parseDuration(team.runs.every)) return;

    if (draft && (draft.edited || draft.held)) {
      record("waiting", now, { note: draft.held ? "draft held" : "draft edited" });
      return say(`Your draft is waiting for you (${draft.held ? "held" : "you edited it"}). \`houston draft\` to see it, \`houston publish\` to publish it.`, true);
    }

    try {
      ensureTodayPages(now);
    } catch (e) {
      say(`Couldn't create today's pages: ${(e as Error).message}`);
    }
    const lastPublish = readState().last_publish;
    const since = lastPublish ? new Date(lastPublish) : new Date(now.getTime() - 86_400_000);
    const digest = collect(team, local, since, now);
    const digestText = renderDigest(digest, team);
    mkdirSync(paths.localDir, { recursive: true });
    writeFileSync(paths.digest, digestText);
    if (isQuiet(digest)) {
      record("quiet", now, { sources: digest.sources });
      return say(`Nothing new since ${at(since, local.timezone)}.`);
    }

    startDraft(ctx, { start: since, end: now }, digest.sources, digest.inbox, now);
    const agent = startAgent(ctx, prompt(ctx, digestText, now));
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

    if (team.rules.publish_runs === "auto" || (draft.deadline && draft.deadline <= now)) {
      publishDraft({ notReviewed: true, now });
      return say("Published your updates.");
    }
    record("drafted", now, { sources: digest.sources });
    const when = draft.deadline ? `It publishes on its own at ${at(draft.deadline, local.timezone)} unless you approve or hold it.` : "It publishes when you approve it.";
    notify("Your Houston draft is ready to review.");
    say(`Your draft is ready. ${when}\n\`houston draft\` to read it, \`houston publish\` to approve, \`houston draft hold\` to keep it back.`, true);
  },
} satisfies Command;
