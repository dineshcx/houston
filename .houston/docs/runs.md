# Runs

A run turns what you did into your updates: your day log, your section of each open cadence page, and the living summaries and status of the issues you touched. It runs on your laptop, started by your own scheduler, every few hours.

Your scheduler runs it as `.houston-local/core/bin/houston run`, the copy of Houston you approved (see [Scheduling](#scheduling)). To try one yourself, `.houston/bin/houston run` is fine.

## What a run does, step by step

1. **Check the core.** If `.houston/` or the team's `skills/run/SKILL.md` changed since you last trusted it, the run stops and asks you to review the change and run `houston trust`.
2. **One at a time.** If another run (or a `houston publish`) is going on this laptop, it leaves it to finish and stops.
3. **Pull** the Houston repo, so it has your teammates' latest pages and any merged proposals. If the pull fails, it carries on with what's there. If the pull brought a core change, it stops as in step 1.
4. **Apply your merged intake proposals** (those whose `owner` is you). See [intake.md](intake.md).
5. **Publish an overdue draft.** If your draft's deadline has passed and you didn't hold it, it publishes now: marked "not reviewed" unless you edited it. If publishing fails (say a section names a frozen period), the draft is held, the run records why, and you get a notification saying what to fix.
6. **With `--if-due`**, stop here if the last run was less than `runs.every` ago.
7. **Wait for you** if your draft is held or you edited it: the run won't replace your work. It says so and stops.
8. **Make today's pages.** Creates `_page.md` (the Notes) for every cadence period open today, if missing.
9. **Collect** your evidence since your last published run (or the last 24 hours), and write the digest to `.houston-local/digest.md`.
10. **Skip if quiet.** If nothing new happened, it records a quiet run and stops without calling a model.
11. **Draft.** Starts Claude Code headless (`claude -p`, model `runs.model`, at most `runs.max_turns` turns, 10 minutes at most) with the run skill, this run's facts, the current content of your files, and the digest. It's locked down: it runs in an empty temporary folder, its only tool is the shell, and the only commands allowed are the trusted copy's `houston draft add` (text on stdin, not `--file`) and `houston issues`. It can't read files, has no MCP servers, and none of your user or project Claude Code settings (allow rules, hooks) apply. It writes the whole draft in one `houston draft add` call, every section in the draft's own format (`<!-- houston:<kind> <target> -->` lines); each section is checked as it's added.
12. **Publish or wait**, per `rules.publish_runs`:
    - `auto`: publishes now.
    - `review`: waits until you run `houston publish`.
    - `review_until_deadline` (default): you get a notification ("Your Houston draft is ready to review.") and the draft publishes on its own `publish_deadline` before your next cadence.

If the agent fails, the draft is thrown away and the run is recorded as failed; the next run covers the same time again. The same goes for an agent that drafted nothing because it tried commands Houston doesn't allow: the run is recorded as failed with the refused commands, not as quiet. An agent that read everything and found nothing worth writing is a quiet run, and the next run starts from now. Extra runs are safe: each only adds what's new.

## What a run reads

| Source | What |
| --- | --- |
| GitHub | your activity in the team's repos (issues, PRs, commits, reviews, comments) and the open issues assigned to you |
| Local git | in each linked repo and its worktrees: your commits (by your `git config user.email`), unpushed commits, uncommitted changes, branch names |
| Inbox | the lines in each linked repo's `.houston-inbox.md` |
| Sessions | your Claude Code sessions in each linked repo and its worktrees (`~/.claude/projects/`): what you asked and the last answer, cut short |

Each source is recorded as ok or failed, and the result shows in the footer of every section you publish, like `_run 09:00 · sources: github ok, git ok, inbox ok, sessions ok · not reviewed_`. A failed source shows as incomplete, never as a quiet day. Repos marked "not on this machine" only contribute GitHub activity.

**What stays on your laptop.** The digest, your session text, uncommitted changes and the draft are files in `.houston-local/` (gitignored) and in your local repos. The run's agent reads them to write the draft, but nothing reaches GitHub or the Houston repo except what's in the draft when it publishes. The run skill tells the agent to describe work in its own short words and never copy chat text, file contents or secrets; read your draft to check.

All free text (comments, PR descriptions, session text, inbox lines) is fenced in the digest as `<untrusted>`: the agent treats it as a record of what happened, never as instructions.

## How work is matched to issues

Each piece of evidence is matched to one issue, in this fixed order. The first match wins:

1. a PR that references an issue (`fixes #12`);
2. an event on the issue itself (you opened, closed or commented on it);
3. an issue number in the branch name (`12-retry`, `feature/12-retry`, `fix-12`);
4. an issue number in a commit message;
5. an issue named in an inbox line (`acme/web#12` or `#12`);
6. the full title of an issue assigned to you, mentioned word for word.

Anything else goes under **Other**. Nothing is guessed and nothing is dropped, so two runs over the same evidence always sort it the same way. Naming the issue in your branch, commit or PR is the surest way to get credit on the right issue.

## The draft and the deadline

The draft is `.houston-local/draft.md` (format in [concepts.md](concepts.md#drafts)).

```sh
houston draft            # read it and when it publishes
houston publish          # approve now
houston draft hold       # keep it back; it waits past the deadline
houston draft release    # let a held draft publish again
houston draft discard    # throw it away; the next run covers that time again
```

With `review_until_deadline`, the deadline is `publish_deadline` (15 minutes) before the next cadence time of your projects that has runs as a writer, if that's within a day. Otherwise it's one `runs.every` after the draft was made. A 10:00 standup and a draft made at 09:00 means it publishes at 09:45.

A draft only publishes when `houston run` runs (from your scheduler, or the catch-up below), so a run at or after the deadline time is what sends it. `houston schedule` suggests one.

## Scheduling

Houston doesn't install schedules. You put one instruction in any scheduler you already use: an agent app's scheduled tasks, cron, launchd. It must run **on your laptop**, not in the cloud: the run needs your repos and sessions.

```sh
houston schedule
```

prints the instruction, suggested times (about an hour before each cadence, at each publish deadline, and every `runs.every` from 09:00 to 18:00), a crontab example (with the `PATH` cron needs) and a sentence for an agent app. Whichever scheduler you use, the task needs `bun`, `claude`, `gh` and `git` on its `PATH`. The instruction is

```sh
cd <houston repo> && <houston repo>/.houston-local/core/bin/houston run
```

It runs your trusted copy, not `.houston/bin/houston`: a change someone pushes to `.houston/` can't run on your laptop until you've reviewed it and run `houston trust` (see [concepts.md](concepts.md#the-trusted-core)). Use the instruction exactly as printed.

Once it's set up, record it so `houston doctor` can check it:

```sh
houston schedule --set "crontab, Mon–Fri 09:00, 09:45, 12:00, 15:00, 18:00"
```

Improving how runs work never means editing your scheduler: the instruction stays `houston run`, and the real instructions live in the run skill.

## Catching up

`houston link` writes a block into `~/.claude/CLAUDE.md` listing the Houston repos linked on this laptop (one block serves several teams). When you open Claude Code in a code repo whose `.houston` file points at one of those Houston repos, the block tells it to run `<houston repo>/.houston-local/core/bin/houston run --if-due --quiet` in the background. A `.houston` file pointing anywhere else is ignored, since anyone can commit one to a repo. A laptop that was shut at 09:30 catches up minutes after you start working, and an overdue draft publishes. The same block tells your agent to leave a line in `.houston-inbox.md` when it finishes something, makes a decision or gets blocked.

`houston link --no-global` leaves `~/.claude/CLAUDE.md` alone (doctor then warns that catch-up won't happen); `houston link --remove` takes only this Houston repo out of the block.

## When a run goes wrong

Start with:

```sh
houston doctor
```

It checks your tools, sign-in, setup, links, the global block, core trust, the last run's outcome and any waiting draft, with a fix for each problem. Then run `houston run` yourself to see its message, and `houston collect` to see exactly what it read. Common cases are in [troubleshooting.md](troubleshooting.md).
