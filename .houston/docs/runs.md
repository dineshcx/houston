# Runs

A run turns what you did into your updates: your day log, your section of each open cadence page, and the living summaries and status of the issues you touched. It runs on your laptop, started by your own scheduler, every few hours.

```sh
.houston/bin/houston run
```

## What a run does, step by step

1. **Check the core.** If `.houston/` changed since you last approved it, the run stops and asks you to review it and run `houston trust`.
2. **Pull** the Houston repo, so it has your teammates' latest pages and any merged proposals. If the pull fails, it carries on with what's there.
3. **Apply your merged intake proposals** (those whose `owner` is you). See [intake.md](intake.md).
4. **Publish an overdue draft.** If your draft's deadline has passed and you didn't hold it, it publishes now: marked "not reviewed" unless you edited it.
5. **With `--if-due`**, stop here if the last run was less than `runs.every` ago.
6. **Wait for you** if your draft is held or you edited it: the run won't replace your work. It says so and stops.
7. **Make today's pages.** Creates `_page.md` for every cadence period open today, if missing.
8. **Collect** your evidence since your last published run (or the last 24 hours), and write the digest to `.houston-local/digest.md`.
9. **Skip if quiet.** If nothing new happened, it records a quiet run and stops without calling a model.
10. **Draft.** Starts Claude Code headless (`claude -p`, model `runs.model`, at most `runs.max_turns` turns, 10 minutes at most) with the run skill, this run's facts, the current content of your files, and the digest. The agent may only run `houston draft …`, `houston issues …` and read files. It writes your draft section by section with `houston draft add`; each section is checked as it's added.
11. **Publish or wait**, per `rules.publish_runs`:
    - `auto`: publishes now.
    - `review`: waits until you run `houston publish`.
    - `review_until_deadline` (default): you get a notification ("Your Houston draft is ready to review.") and the draft publishes on its own `publish_deadline` before your next cadence.

If the agent fails, the draft is thrown away and nothing is recorded, so the next run covers the same time again. Extra runs are safe: each only adds what's new.

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

prints the instruction (`cd <houston repo> && <houston repo>/.houston/bin/houston run`), suggested times (about an hour before each cadence, at each publish deadline, and every `runs.every` from 09:00 to 18:00), a crontab example (with the `PATH` cron needs) and a sentence for an agent app. Once it's set up, record it so `houston doctor` can check it:

```sh
houston schedule --set "crontab, Mon–Fri 09:00, 09:45, 12:00, 15:00, 18:00"
```

Improving how runs work never means editing your scheduler: the instruction stays `houston run`, and the real instructions live in the run skill in this repo.

## Catching up

`houston link` writes a block into `~/.claude/CLAUDE.md`. When you open Claude Code in a linked repo, the block tells it to run `houston run --if-due --quiet` in the background. A laptop that was shut at 09:30 catches up minutes after you start working, and an overdue draft publishes. The same block tells your agent to leave a line in `.houston-inbox.md` when it finishes something, makes a decision or gets blocked.

## When a run goes wrong

Start with:

```sh
houston doctor
```

It checks your tools, sign-in, setup, links, core trust, the last run's outcome and any waiting draft, with a fix for each problem. Then run `houston run` yourself to see its message, and `houston collect` to see exactly what it read. Common cases are in [troubleshooting.md](troubleshooting.md).
