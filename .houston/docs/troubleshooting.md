# Troubleshooting

Start with `houston doctor` (from the Houston repo: `.houston/bin/houston doctor`). It checks everything below and prints a fix next to each problem. To see what a run read, run `houston collect`.

## "gh signed in" fails

```
✗ gh signed in — Run `gh auth login`.
```

Houston talks to GitHub through the GitHub CLI. Run `gh auth login`, then `houston doctor` again. If doctor says "couldn't reach GitHub", you're signed in but offline; try again later. If you're signed in as the wrong account, `gh auth switch`.

## The run says the core changed

```
houston: Houston's core (.houston/) changed since you last approved it, so it won't run unattended.
```

Someone updated `.houston/` (usually a merged `houston update`) and you pulled it. Runs only use a core you approved, because the code in it runs on your laptop. Look at what changed, then approve it:

```sh
git log -p -- .houston
.houston/bin/houston trust
```

If doctor also says `core X doesn't match core: Y in houston.yml`, pull the Houston repo (a teammate updated it) or run `houston update`.

## "Your draft is waiting for you"

A run found your draft held or edited, and won't replace your work. Decide what to do with it:

```sh
.houston/bin/houston draft            # read it
.houston/bin/houston publish          # publish it
.houston/bin/houston draft release    # it was held: let it publish at its deadline
.houston/bin/houston draft discard    # throw it away; the next run covers that time again
```

If `publish` says the draft can't be published, it lists each problem (a frozen period, an issue outside the team's repos, a label Houston doesn't manage). Fix those lines in `.houston-local/draft.md`, or delete the section, and publish again.

## Push rejected

```
houston: Committed, but couldn't push to the Houston repo. Run `git -C <repo> push` to see why.
```

Your files are committed locally and your draft is kept. Run the `git push` it names to see the reason:

- **Someone pushed first and the pull failed**: you have local changes in the Houston repo that conflict. Commit or stash them, then `git pull --rebase`.
- **Branch protection requires pull requests**: runs push pages straight to the default branch, so protect only the core paths (see `.github/CODEOWNERS.example`), not the whole branch.
- **No permission**: ask a lead to give you write access to the Houston repo.

Then run `houston publish` again. Anything already done isn't done twice.

## `houston link` can't find a repo

```
Couldn't find acme/api on this machine.
```

`houston link` looks up to 3 folders deep under `~/code`, `~/Code`, `~/Repo`, `~/repos`, `~/projects`, `~/Projects`, `~/Developer`, `~/src`, `~/work` and `~/dev`, for a main checkout (a `.git` folder, not a worktree) whose `origin` is that repo on GitHub. Fix it one of these ways:

```sh
gh repo clone acme/api ~/code/api && .houston/bin/houston link    # clone it
.houston/bin/houston link --repo acme/api=/path/to/clone          # it's somewhere else
.houston/bin/houston link --repo acme/api=none                    # you don't work on it here
HOUSTON_SCAN_DIRS=/Volumes/work .houston/bin/houston link         # search another folder too
```

If it says a folder "has origin … not acme/api", that clone points somewhere else (a fork, an old name). Point `--repo` at the right clone.

## No sessions found

The digest shows no Claude Code sessions though you worked with Claude Code. Sessions are matched by the exact folder Claude Code was started in. Check:

- You started Claude Code at the **root** of a linked repo or one of its worktrees. A session started in a subfolder (`~/code/web/packages/ui`) or a parent folder isn't counted.
- The repo isn't marked `none` in `houston.local.yml` and its path is right (`houston doctor`).
- The session happened after your last published run; `houston collect --since <ISO time>` looks further back.

The same applies to git work: commits only count when they're authored with this repo's `git config user.email`. If it isn't set, the digest shows `git failed: git user.email isn't set`; set it and run again.

## A summary was skipped because someone edited the issue

```
acme/web#12: @raj edited acme/web#12 in the last 10 minutes; trying again next run
```

Houston never writes a summary over a person's fresh edit. The rest of the draft published. A later run writes the summary again if there's new work on that issue; to set it now, use:

```sh
.houston/bin/houston summary acme/web#12 --set --file summary.md
```

## Label not found

If a run or `houston labels` fails because `status:in-progress` (or `p1`, `kind:bug`) doesn't exist in a repo, create Houston's labels in every team repo once:

```sh
.houston/bin/houston labels sync
```

Run it again after adding a repo to `houston.yml`.

## The scheduler runs but nothing happens

- `houston doctor` shows the last run's time and outcome. "Quiet" means nothing new since your last published run: that's normal.
- Cron starts jobs with a bare `PATH`; if `bun`, `claude`, `gh` or `git` aren't found, use the crontab line `houston schedule` prints, which sets `PATH`.
- The scheduler must run on your laptop. A cloud task has none of your repos or sessions.
- "The run's agent failed": the message says why (often Claude Code not signed in). Nothing was drafted; the next run covers the same time again.
