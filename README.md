# Houston

Houston keeps a team's context in one place: what everyone did, what each issue is about, and what was decided in meetings. Each person's agent writes it from the work they already do, so nobody writes status updates by hand.

It is this template repo plus a small command-line tool (`houston`) and a local app. Your team makes its own copy, and everyone talks to it through Claude Code.

## The problem

Status lives in people's heads, in chat and in issues nobody updated. Standup turns into everyone remembering yesterday. Decisions made in meetings never reach the issue. A new person can't tell what's going on without asking around.

Houston fixes that by writing it down as a side effect of the work:

- Every few hours, a run on your laptop reads your recent work (GitHub activity, your local git work, your Claude Code sessions) and drafts your update.
- Each issue gets a **living summary** at the top: goal, state, next step, decisions, open questions.
- Meetings become notes and proposed issue changes, reviewed as one pull request.

## A day with Houston

1. **The manager sets up the team** (about 10 minutes). Creates the team's repo from this template, opens Claude Code in it and says "set me up". Houston asks about projects, repos, how the team meets, and what agents may do.
2. **A member joins** (about 2 minutes). Clones the team's repo and says "set me up". Houston only asks what's personal: where their repos are and when to run.
3. **A normal day.** Everyone works as usual. Every few hours their run drafts their updates. They can read, fix or approve the draft; if they do nothing, it publishes 15 minutes before standup, marked "not reviewed". At standup, today's page already shows each person's done, doing and blocked, linked to issues.
4. **Work comes in.** After a meeting, someone says "turn this meeting into issues". Houston opens one pull request with the notes and the proposed issue changes. The meeting owner edits it if needed and merges; the changes are made.
5. **The team changes how it works.** "We're moving to two-week sprints." The manager says it to the agent in the Houston repo; it edits the setup, checks it, shows the change and commits after a yes.
6. **Houston gets better.** `houston update` brings in a new version as a pull request. Your setup and notes are never touched.

## Quick start

You need [git](https://git-scm.com), the [GitHub CLI](https://cli.github.com) (`gh auth login` done), [Bun](https://bun.sh) and [Claude Code](https://claude.com/claude-code).

**Manager (first person on the team):**

1. On GitHub, click **Use this template** on this repo and create your team's repo (private), for example `acme/web-team-houston`.
2. Clone it and open Claude Code in it:
   ```sh
   gh repo clone acme/web-team-houston ~/code/web-team-houston
   cd ~/code/web-team-houston
   claude
   ```
3. Say **"set me up"** and answer its questions. It shows you the team's setup (`houston.yml` and your cadences) to approve, then your personal plan. After your yes it links your repos on this laptop, commits the team's setup and creates Houston's status, priority and kind labels in your code repos (`houston labels sync`).
4. When it asks, say yes to pushing: teammates clone what you push.
5. Put the instruction it shows in a scheduler on this laptop, at the times it suggests, with `bun`, `claude`, `gh` and `git` on its `PATH`. It runs `.houston-local/core/bin/houston run`, your approved copy of Houston (see [Updating Houston](#updating-houston)).
6. Send the repo link to your team.

**Member:**

1. Clone the team's Houston repo and open Claude Code in it.
2. Say **"set me up"**, then put the instruction it shows in your scheduler.

Saying "set me up" again is always safe. It fixes what's missing and changes nothing else. Not sure where you are? `.houston/bin/houston doctor` checks everything and says what to do next.

## What lives where

```
web-team-houston/                  the Houston repo (one per team)
├── houston.yml                    the team: people, projects, repos, rules
├── cadences/                      one file per recurring page: daily.md, sprint.md
├── projects/storefront/
│   ├── daily/2026-11-13/
│   │   ├── _page.md               the day's Notes, written by people
│   │   ├── ana.md                 Ana's Update, written by her runs
│   │   └── raj.md                 Raj's Update, written by his runs
│   ├── meetings/                  notes from other meetings
│   └── ideas.md                   ideas from meetings with no repo yet
├── people/ana/2026-11-13.md       Ana's day log
├── proposals/                     intake proposals waiting to be applied
├── skills/                        your team's own versions of Houston's skills
├── templates/                     optional: your own summary for new issues
├── .houston/                      Houston itself: CLI, app, skills, docs
├── houston.local.yml              yours only, not committed
└── .houston-local/                yours only: your draft, run state, your approved copy of Houston
```

**Issues stay in your code repos** (`acme/web`, `acme/api`). Houston updates their summaries and labels, but **nothing is ever committed to a code repo**. The two small files it keeps there (`.houston` and `.houston-inbox.md`) are hidden from git through `.git/info/exclude`.

## Daily use

**Your draft.** When a run has something, you get a note: "Your Houston draft is ready to review." Then, in a terminal or by asking your agent:

```sh
.houston/bin/houston draft          # read it, and when it publishes on its own
.houston/bin/houston publish        # approve it now
.houston/bin/houston draft hold     # keep it back until you decide
```

The draft is a plain file, `.houston-local/draft.md`. Edit it, then publish. Later runs never overwrite a draft you edited; only a held draft waits past its deadline.

**The app.** `.houston/bin/houston app` opens a local page (on `127.0.0.1:4317`) with each cadence page (the team's Notes and everyone's Update), a board of the team's issues, intake pull requests to review and merge, your draft, and who has run lately. See [app.md](.houston/docs/app.md).

**Intake.** In the Houston repo, give your agent a transcript, notes, a Slack thread or an email (a file path, or paste it) and say **"turn this meeting into issues"**. It writes the notes and opens one pull request with the proposed changes. Fix anything on GitHub, then merge it to apply them; close it to throw them away. See [intake.md](.houston/docs/intake.md).

**Your agent keeps notes.** While you work in a linked code repo, your agent adds a line to `.houston-inbox.md` when it finishes something, makes a decision or gets blocked. Your next run uses those lines.

## Changing how the team works

Ask the agent in the Houston repo, in plain words:

- "Standup is at 9:30 now."
- "Move to two-week sprints starting Monday."
- "Add a weekly KPI check."
- "Add acme/api to storefront."
- "Add raj to the team."

It edits `houston.yml` or `cadences/`, runs `houston validate`, shows you the change and commits after you agree. Everyone's next run follows it. `houston explain` shows the current setup in plain words.

## Updating Houston

```sh
.houston/bin/houston update
```

It opens a pull request against your default branch that replaces `.houston/` with the newer version (from `template:` in `houston.yml`, or `--from owner/repo`). Your setup, notes and own skills are untouched.

Schedulers and agents never run `.houston/` straight from the repo. They run `.houston-local/core/`, a copy each person approves with `houston trust` (gitignored, one per laptop), so a change pulled from a teammate can't run on your laptop until you've looked at it. After pulling a change to `.houston/` (or to your team's `skills/run/SKILL.md`), your runs stop and say so. Review it, then trust it:

```sh
git log -p -- .houston skills/run      # and git diff -- .houston skills/run for uncommitted changes
.houston/bin/houston trust
```

Typing `.houston/bin/houston` yourself, in the repo, is fine.

## Docs

- [Glossary](GLOSSARY.md): the words Houston uses
- [Concepts](.houston/docs/concepts.md): how the pieces fit
- [Configuration](.houston/docs/configuration.md): `houston.yml`, cadences, rules, presets
- [CLI](.houston/docs/cli.md): every command
- [Runs](.houston/docs/runs.md): what a run reads, drafts and publishes; scheduling
- [Intake](.houston/docs/intake.md): meetings to issues
- [App](.houston/docs/app.md): the local app
- [Troubleshooting](.houston/docs/troubleshooting.md): common problems and fixes
- [Contributing](.houston/docs/contributing.md): improving Houston itself
