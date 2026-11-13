# The houston CLI

Every write and every check Houston makes goes through this one command. Agents decide what to say; the CLI checks it against the team's rules and does it.

Run it from the Houston repo as `.houston/bin/houston` (it needs [Bun](https://bun.sh)). Below it's just `houston`. Schedulers and agents run `.houston-local/core/bin/houston` instead, the copy you approved with `houston trust`; see [schedule](#schedule).

```sh
houston help             # every command, grouped as below
houston help <command>   # its options (or: houston <command> --help)
```

Errors are printed in plain words with what to do next, and exit with status 1.

## Every day

### run

```
houston run [--if-due] [--quiet]
```

Collects your work since your last published run, has Claude Code draft your updates, then publishes or waits for review per the team's rules. This is what your scheduler runs. Only one run happens at a time on a laptop. See [runs.md](runs.md).

| Flag | |
| --- | --- |
| `--if-due` | do nothing if the last run was less than `runs.every` ago (a draft past its deadline still publishes) |
| `--quiet` | print only when something needs you |

### draft

```
houston draft
houston draft add <kind> <target> [--file f]
houston draft hold | release | discard
```

Shows your run's draft and when it publishes; adds or replaces one section; holds it back, lets it publish, or throws it away. Each section is checked when added. The run's agent writes the draft with `draft add`; you'll mostly use the others.

| Kind | Target | Section |
| --- | --- | --- |
| `day` | `YYYY-MM-DD` | your day log (a date in the draft's window) |
| `page` | `<project>/<cadence>/<period>` | your Update on an open cadence page |
| `summary` | `owner/repo#n` | an issue's living summary, without the markers |
| `labels` | `owner/repo#n` | one label per line; `-label` removes it |
| `comment` | `owner/repo#n` | a comment, when the team's rules allow it |

The text comes from `--file`, or stdin. During a run only stdin is accepted, so the agent can't make Houston read other files.

```sh
houston draft add labels acme/web#15 <<'END'
status:in-progress
END
```

### publish

```
houston publish
```

Re-checks the draft (you may have edited it), writes your day log and page Updates, applies summaries, labels and comments, commits and pushes, and removes the inbox lines it used. If anything fails, the draft is kept and publishing again carries on without repeating what's done. If a run is going on right now, it says so; try again in a minute.

### app

```
houston app [--port 4317] [--no-open]
```

Starts the local app on `127.0.0.1` and opens your browser. See [app.md](app.md).

| Flag | |
| --- | --- |
| `--port <n>` | port to listen on (default 4317; 0 picks a free one) |
| `--no-open` | don't open the browser |

## Setting up

### link

```
houston link [--repo owner/name=/path]… [--dry-run] [--remove [--force]] [--no-global]
```

Sets up this laptop. Finds the team's repos (it looks up to 3 levels deep under `~/code`, `~/Repo`, `~/projects`, `~/Developer`, `~/src`, `~/work` and similar folders, plus any in `HOUSTON_SCAN_DIRS`, colon-separated) and writes:

- `houston.local.yml` and `AGENTS.local.md` in the Houston repo;
- `.houston` and an empty `.houston-inbox.md` in each linked repo, both added to its `.git/info/exclude`;
- this Houston repo in the list of the Houston block in `~/.claude/CLAUDE.md` (between `<!-- houston:begin -->` and `<!-- houston:end -->`); the block only follows a `.houston` file that points at a listed repo;
- `commit.gpgsign false` and `core.symlinks false` in the Houston repo's git config;
- approval of the current core (as `houston trust` does).

Running it again only changes what's different. The "set me up" skill runs it for you.

| Flag | |
| --- | --- |
| `--repo owner/name=/path` | use this clone; `=none` means not on this machine. Repeat for several repos. |
| `--dry-run` | print the plan and write nothing |
| `--remove` | undo it all for this Houston repo; other Houston repos in the block stay. An inbox that still has notes is kept unless you add `--force`. `houston.local.yml` is kept. |
| `--no-global` | leave `~/.claude/CLAUDE.md` alone |

```sh
houston link --dry-run --repo acme/api=~/work/api
```

### doctor

```
houston doctor
```

Checks this laptop: git, Bun, Claude Code, `gh` sign-in, `houston.yml` and cadences, your links, the global block, core trust, the last run, a waiting draft and your recorded schedule. Prints a fix for each problem and exits 1 if any check fails. On a repo that isn't set up yet, its first line says to say "set me up" to your agent. A missing global block is only a warning, since you may have linked with `--no-global`. Start here when something seems wrong.

### schedule

```
houston schedule [--set "<sentence>"]
```

Prints the one instruction your scheduler should run, suggested times from your team's cadences in your timezone, a crontab example and a sentence to give an agent app's scheduled tasks. The instruction runs your trusted copy:

```sh
cd <houston repo> && <houston repo>/.houston-local/core/bin/houston run
```

Houston doesn't install schedules. `--set` records which scheduler you used, in `houston.local.yml`.

```sh
houston schedule --set "crontab, Mon–Fri 09:00, 09:45, 12:00, 15:00, 18:00"
```

### trust

```
houston trust
```

Approves the current core for unattended runs: copies `.houston/` to `.houston-local/core/` (gitignored, per laptop) and records it. Your team's `skills/run/SKILL.md` is part of what you approve. Runs refuse to start when either changed since you last trusted it, because anyone who can push to the Houston repo could otherwise run code on your laptop. Review the change first:

```sh
git log -p -- .houston skills/run
git diff -- .houston skills/run      # uncommitted changes
houston trust
```

### update

```
houston update [--from owner/repo] [--ref <tag>]
```

Fetches the Houston template (default: `template:` in `houston.yml`) at a tag or its default branch. If its core is newer, it opens a pull request against your default branch that replaces `.houston/` and bumps `core:` in `houston.yml`. Your setup, notes and own skills are never touched, and your current branch isn't changed. After it's merged, each person pulls, reviews and runs `houston trust`.

```sh
houston update --ref v0.2.0
```

## Your team's setup

### validate

```
houston validate
```

Checks `houston.yml`, every file in `cadences/` and the issue template (`templates/issue.md`, or the core's), listing every problem in plain words. Exits 1 if anything is wrong. Run it after any edit to them; CI runs it too.

### explain

```
houston explain
```

The team's setup in plain words: people, projects, repos, cadences, status columns, what agents may do, and how runs publish.

### skill

```
houston skill [<name>]
```

With a name, prints the path of the `SKILL.md` to follow: the team's `skills/<name>/SKILL.md` if there is one, otherwise the core's. Without one, lists every skill and marks team overrides.

```sh
houston skill intake
```

## Used by agents and skills

You can run these yourself; skills and runs use them for you.

### collect

```
houston collect [--since <ISO time>]
```

Gathers your evidence (GitHub activity, local git work, inbox lines, Claude Code sessions), matched to issues. Prints the digest and writes it to `.houston-local/digest.md`. It's exactly what a run reads, so use it to see what Houston sees. Writes nothing else.

| Flag | |
| --- | --- |
| `--since` | start of the window (default: your last published run, or 24 hours ago) |

```sh
houston collect --since 2026-11-13T06:00:00Z
```

### issues

```
houston issues [--project <id>] [--mine] [--json]
```

Open issues across the team's repos, with their status and whether they have a living summary.

| Flag | |
| --- | --- |
| `--project` | only this project's repos |
| `--mine` | only issues assigned to you |
| `--json` | print JSON |

### summary

```
houston summary <owner/repo#n>
houston summary <owner/repo#n> --set [--file f]
```

Prints an issue's living summary, or replaces it with the text from the file (or stdin). Only the block between the markers changes. It backs off if someone else edited the issue in the last 10 minutes. For interactive use; runs go through the draft.

```sh
houston summary acme/web#12 --set --file /tmp/summary.md
```

### labels

```
houston labels <owner/repo#n> <label>… [-<label>]…
houston labels sync
```

Adds labels (`-label` removes one) under the team's rules. Only status, priority and kind labels are allowed, and setting a status removes the issue's other status. `sync` creates the status, priority and kind labels in every team repo; the first person runs it during "set me up", and again after adding a repo. A label that's missing in a repo is also created the first time Houston sets it there.

```sh
houston labels acme/web#12 status:in-review p1
```

### page

```
houston page <project> <cadence> [--date YYYY-MM-DD]
```

Makes sure a cadence period's folder and its Notes (`_page.md`) exist (the period containing that date; default today), and commits and pushes a new one. Runs do this for every period open today.

```sh
houston page storefront daily --date 2026-11-16
```

### propose

```
houston propose --title "<title>" --notes <path in repo> --proposal <file> [--dry-run]
```

Opens one intake pull request in the Houston repo with a meeting's notes and its proposed issue changes. It pulls the Houston repo first (and stops if it can't), checks the proposal, fills in `title`, `owner` (you) and `source` (the notes path), and saves it as `proposals/<date>-<slug>.yml` on a branch `intake/<date>-<slug>`, made from the default branch in a temporary worktree. If `projects/<project>/ideas.md` has uncommitted lines, it goes in the same pull request.

Afterwards your checkout goes back to how the repo is: a tracked notes file (or `ideas.md`) is restored, and a new, untracked one is deleted. Your changes are in the pull request and come back when it's merged and you pull. The intake skill runs it for you. See [intake.md](intake.md).

| Flag | |
| --- | --- |
| `--title` | what the meeting or thread was, like "Daily sync 13 Nov" |
| `--notes` | the notes file, as a path inside the Houston repo |
| `--proposal` | the proposal YAML to open for review |
| `--dry-run` | print the pull request and its files without writing anything |

```sh
houston propose --title "Design sync 13 Nov" --notes projects/storefront/meetings/2026-11-13-design-sync.md --proposal .houston-local/intake/design-sync.yml --dry-run
```

### apply

```
houston apply <proposal file>
houston apply --pending
```

Pulls the Houston repo first, then applies a merged proposal, change by change, through the team's rules; records the result in the file, moves it to `proposals/applied/` and comments the results on the pull request. If a change fails, it records what landed and the next attempt continues from there. `--pending` applies every merged proposal you own; runs do this for you.

```sh
houston apply proposals/2026-11-13-design-sync.yml
```
