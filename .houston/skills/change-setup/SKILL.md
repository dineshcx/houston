---
name: change-setup
description: Change how the team works by talking, in the Houston repo. Use when someone says things like "move to two-week sprints", "add a weekly KPI check", "standup is at 9:30 now", "add the api repo to storefront", "let agents close issues", or "add raj to the team".
---

# Change the team's setup

The team's way of working lives in two places in this repo: `houston.yml` (people, projects, repos, sources, rules, runs) and `cadences/*.md` (one recurring page each). Everyone's next run follows whatever is committed here, so a change is a decision for the team: make it carefully, show it, and commit only when the person agrees.

The `houston` CLI is `.houston/bin/houston`.

## How to work

- Look facts up yourself: `houston explain` for the current setup, `cat houston.yml`, `ls cadences/`, `gh repo view` for a repo's name and visibility. Ask only what you can't find.
- If the request is ambiguous, ask one numbered round with your recommended reading, worded so "yes" accepts it ("1. Two-week sprints starting Monday 16 Nov, planning at 10:00? Recommend yes: it matches your current standup time.").
- Never edit `.houston/`: it's the core and `houston update` replaces it. A team that wants a different workflow puts its own `skills/<name>/SKILL.md`, which overrides the core skill of that name (`houston skill` lists them).
- Pushing is the person's call.

## Steps

1. **Understand the change.** Run `houston explain`. Say back, in one or two sentences, what will change and what stays the same. Done when the person agrees that's what they mean.

2. **Edit.** Make the smallest edit that does it, keeping comments and order in `houston.yml`:
   - A new cadence: copy the closest file from `.houston/presets/*/cadences/` into `cadences/<name>.md`, set its `title`, `schedule` (like `"Mon-Fri 09:30"` or `"Mon 10:00"`, in each person's own timezone), `period` (`day`, `week`, `sprint`, `month`), and for sprints `sprint_start` (the first day of any sprint) and `sprint_length` (`1w`, `2w`, `3w`). Then add its name to the `cadences:` list of each project that uses it.
   - Changing a cadence: edit its front matter. The body is what each person's section follows; `page:` is what the people's page starts with (only `{{title}}`, `{{period}}` and `{{project}}` may appear).
   - Dropping a cadence: remove it from the projects' `cadences:` lists; delete the file only if no project uses it. Past pages stay.
   - Repos, people, sources, rules, runs: edit `houston.yml`. A repo belongs to one project. Every lead must also be a member. If a new repo is public, recommend `rules.summary_on_issue: false`.
   - Moving a cadence's time changes when drafts auto-publish: tell the person each member should check `houston schedule` and adjust their scheduler.

   Done when the files say what was agreed and nothing else changed.

3. **Check.** Run `houston validate`. Fix every problem it lists and run it again. Done when it prints ✓.

4. **Show.** Show `git diff -- houston.yml cadences/`, then the part of `houston explain` that changed, so the person sees the change both as text and in plain words. Done when the person has seen both.

5. **Commit, after a yes.** Ask "Commit this?". On yes: `git add houston.yml cadences/ && git commit -m "<one line: what changed and why>"`, for example `Move to two-week sprints starting 16 Nov: planning was too frequent`. Then ask whether to push; on yes, `git push`. If they say no, leave the edits uncommitted and say how to undo them (`git checkout -- houston.yml cadences/`).

   Done when the change is committed (and pushed, if they said so), or the person chose to leave it.

After a pushed change, teammates pick it up on their next run. If the change added a repo, each person who works on it runs `houston link` (or says "I cloned a new repo" to their agent).
