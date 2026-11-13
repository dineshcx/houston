---
name: set-me-up
description: Set a person up with Houston in this repo, as the team's first person (writes houston.yml) or as a member joining (personal part only). Use when someone says "set me up", "I cloned a new repo", "show me my schedule again" or "stop my runs".
---

# Set me up

You are in a team's Houston repo. The `houston` CLI is `.houston/bin/houston` (below just `houston`); it does every write and every check. You decide what to ask and what to propose.

## How to work

- **Look facts up yourself** (`houston doctor`, `git`, `gh`, `houston link --dry-run`, the filesystem). Bring the person decisions, never questions you could answer.
- **Ask in numbered rounds.** Each question has your recommended answer, worded so "yes" accepts it. A question that depends on an unanswered one waits for a later round.
- **Read only until the person approves.** Nothing is written before they say yes: the team's files after step 3's approval, everything else after the plan in step 5. Nothing is committed until step 6.
- **Never open `.env` files, keys or other secret files**, in this repo or the code repos.
- **Pushing is the person's call.** Commit when they approve; ask before `git push`.
- Every step ends on its **done when**. Don't move on until it holds.
- Saying "set me up" again is always safe: every step replaces, never adds. Re-running is how you fix a half-finished setup.

## Words

- **Houston repo**: this repo. **Code repos**: the team's GitHub repos in `houston.yml` → `projects.*.repos`.
- **Cadence**: a recurring page (daily standup, weekly sync, sprint, KPI check), one file in `cadences/`.
- **Run**: `houston run`, which the person's own scheduler starts every few hours. It drafts their updates; they publish on review or automatically before the cadence.

## Steps

### 1. Check

Run `houston doctor`. Read every ✗ and ! line. Fix what the person must fix (`gh auth login`, installing Bun or Claude Code) by telling them the exact command; ignore lines that later steps fix (not set up yet, no houston.local.yml, not linked, no Houston block, core not trusted yet, no schedule).

Done when git, gh (signed in), bun and claude pass, or the person has the fix for each.

### 2. Clean up earlier setups

Look for anything an earlier Houston or Mission Control setup left behind, so nothing runs twice or writes to an old file:

- Blocks in `~/.claude/CLAUDE.md` with older markers: `<!-- standup:inbox -->`, `team-notes:inbox`. (A Houston block between `<!-- houston:begin -->` and `<!-- houston:end -->` stays: `houston link` adds this repo to its list, and it may already list another team's Houston repo.)
- Old inbox files in the team's code repos (`.standup-inbox.md`, `.team-notes-inbox.md`) and their lines in `.git/info/exclude`.
- Schedules that run an older routine: `crontab -l`, `~/Library/LaunchAgents/*standup*` / `*mission-control*` / `*houston*`, and your agent app's scheduled tasks. A `schedule:` line in an existing `houston.local.yml` names the current one: keep it.

List what you found in one numbered round ("1. Remove the `standup:inbox` block from ~/.claude/CLAUDE.md? Recommend yes: Houston's block replaces it."). An old inbox with lines in it: recommend keeping it until its notes are published.

Done when the person has said keep or remove for each item (removal itself happens in step 6).

### 3. Team questions (first person only)

Skip this step when `houston.yml` is committed: the person is joining. Tell them who the team's leads are (`houston explain`) and go to step 4. If it exists but isn't committed, an earlier first setup stopped part way: show it, ask what to change, and carry on from the approval below.

Look up first: `gh repo list <org> --limit 100 --json nameWithOwner,pushedAt,description` for the orgs in `gh api user/orgs -q '.[].login'` and their own account. Read the presets in `.houston/presets/*/README.md`.

1. **Round 1: projects and repos.** Propose projects (an id like `storefront`, a name) grouping the repos with recent pushes, each repo with a one-line `about` from its description. Ask who the leads and members are (GitHub usernames); recommend the person as the only lead.
2. **Round 2: how the team works.** Offer the presets: daily standup, weekly sync, sprints with a KPI check (they combine). Turn plain words into cadences: "standup at 10, two-week sprints from Monday" → `daily.md` at `Mon-Fri 10:00`, `sprint.md` with `sprint_start` on a recent Monday and `sprint_length: 2w`. A cadence's `schedule:` is days then a 24-hour time, in the team's words: `Mon-Fri 10:00`, `Mon 09:30`, `Mon,Thu 16:00`, `daily 09:00`, `weekdays 09:00`. Ask which projects each cadence belongs to; recommend all.
3. **Round 3: rules.** Show the default rules in sentences and ask only "anything here you'd change?":
   - Agents move issues between status columns and set priority and kind labels (`status`, `labels`: `auto` or `never`).
   - New issues are only proposed; a person approves them in an intake pull request (`create_issue`: `review` or `never`).
   - Work spanning repos gets a main issue with sub-issues (`sub_issues`: `auto` or `never`).
   - Agents comment only to flag a blocker or a question (`issue_comment`: `none`, `blockers_only` or `summary_changes`).
   - Agents keep a living summary at the top of each issue (`summary_on_issue`: `true` or `false`).
   - Drafts publish 15 minutes before the cadence unless the person reviews them first (`publish_runs`: `auto`, `review` or `review_until_deadline`; `publish_deadline`).
   - Houston never closes issues; people do. This isn't a setting.

   Check each repo's visibility (`gh repo view <repo> --json visibility`); if any is public, recommend `summary_on_issue: false` and say why: summaries would publish private work. Houston reads GitHub activity, the person's Claude Code sessions and their inbox file; there is nothing else to connect, so don't ask about other sources.

Then draft `houston.yml` and the cadences: copy the chosen preset files from `.houston/presets/<preset>/cadences/`, edited to the answers. Set `core:` to the contents of `.houston/VERSION`. Set `template:` to the repo this Houston repo was made from:

```sh
gh repo view <owner/name of this Houston repo> --json templateRepository -q '.templateRepository | select(. != null) | "\(.owner.login)/\(.name)"'
```

If that prints nothing, leave `template:` out; `houston update --from owner/repo` works without it. Leave out anything else that matches the defaults (`houston explain` shows them later). The shape:

```yaml
houston: 1
core: 0.1.0
template: acme/houston          # only if the command above printed one
team: { name: Web team, leads: [ana], members: [ana, raj] }
projects:
  storefront:
    name: Storefront
    repos:
      - { repo: acme/web, about: Customer-facing site }
    cadences: [daily, sprint]
rules: { summary_on_issue: false }   # only what differs from the defaults
```

**Approve the team's setup.** Show the drafted `houston.yml` and each cadence's title, schedule and projects, and ask "Write these?". On yes, write `houston.yml` and `cadences/` in this repo (don't commit yet), run `houston validate`, and fix every problem it lists.

Done when the person has approved the team's setup and `houston validate` passes.

### 4. Personal questions (everyone)

Run `houston link --dry-run`. It shows who they are (from `gh`), their timezone, and which team repos it found on disk (it scans `~/code`, `~/Repo`, `~/projects`, `~/Developer` and similar, 3 levels deep). For each repo it didn't find, ask in one round:

- "Clone `acme/api` to `~/code/api`? (recommended)" → after approval, `gh repo clone acme/api ~/code/api`.
- or "It's at another path" → `--repo acme/api=/that/path`.
- or "Not on this machine" → `--repo acme/api=none`.

If a repo was found in the wrong place (an old copy), offer the right one with `--repo`. Confirm the timezone; if it's wrong, it goes into `houston.local.yml` as `timezone:` after linking.

Done when every team repo is found, will be cloned, or is marked not on this machine.

### 5. Plan

Show one table, then ask "Go ahead?":

| What | Where |
| --- | --- |
| Files written | `houston.local.yml`, `AGENTS.local.md` |
| Repos linked | each repo, its path, and the two hidden files (`.houston`, `.houston-inbox.md`) |
| Global block | `~/.claude/CLAUDE.md`, between `<!-- houston:begin -->` and `<!-- houston:end -->`, listing this Houston repo |
| Removed | what the person chose in step 2 |
| Commit | `houston.yml` and `cadences/` with a one-line message (first person) |
| Labels | the status, priority and kind labels created in every team repo (first person) |

Done when the person approves the plan, or has changed it and approved the new one.

### 6. Apply

1. Remove what step 2 agreed to remove.
2. Clone any repos agreed in step 4, then run `houston link` with the `--repo` overrides from step 4. It writes the files, adds this repo to the global block, sets `commit.gpgsign false` and `core.symlinks false` in this repo, and trusts the core (which makes the copy of it that schedules run).
3. First person: commit the team's files (`git add houston.yml cadences && git commit -m "Set up Houston for <team>"`), then run `houston labels sync`: it creates the status, priority and kind labels in every team repo, which must exist before any run or intake changes an issue's status. Push only when the person says so; teammates can't join until it's pushed.
4. **Schedule.** Run `houston schedule` and show the person its output. Houston doesn't install schedules: they put the one instruction it prints, exactly as printed, in a scheduler they already use, at the suggested times (their agent app's scheduled tasks, an orchestrator, cron or launchd). The instruction runs the trusted copy under `.houston-local/core/`, never `.houston/bin/houston`, so a core change someone pushes doesn't run until the person trusts it. If you have a scheduler tool yourself, offer to create the task, on this machine and never in the cloud: the run needs this laptop's repos and sessions. Once it exists, record it in one sentence naming the scheduler, the task's name and when it runs: `houston schedule --set "T3 Code task 'Houston run', Mon–Fri 09:00, 09:45, 12:00, 15:00, 18:00 Asia/Kolkata"`.
5. Run `houston doctor`.

Done when `houston doctor` shows no ✗ and the person confirms the schedule exists. A `!` for the Houston block is fine only if the person chose `--no-global`.

### 7. Show

Run `houston collect` and walk the person through what it found since yesterday: their issues, PRs, sessions and inbox lines, each source's health. This is exactly what a run reads. If a repo is missing, fix its link now (`houston link --repo owner/name=/path`).

Done when the person has seen the digest and says it found the right work.

## Other things people say

- **"Set me up" again**: run all the steps; each one replaces what's there, so nothing doubles up.
- **"I cloned a new repo"**: run `houston link --dry-run`, show what it would change, then `houston link` (with `--repo owner/name=/path` if the clone is outside the usual folders). If the repo isn't in `houston.yml`, it's a team change: use the change-setup skill.
- **"Show me my schedule again"**: run `houston schedule` and show its output, including the recorded schedule.
- **"Change my run time"**: run `houston schedule`, change the task in their scheduler, then `houston schedule --set "<new sentence>"`.
- **"Stop my runs"**: two parts, both needed.
  1. Run `houston link --remove --dry-run`, show what it removes, then `houston link --remove` after they agree. It takes this Houston repo out of the global block (other teams' repos stay listed) and keeps an inbox that still has notes unless they agree to `--force`.
  2. Remove their scheduled task: the one named in `houston.local.yml`'s `schedule:` line (`houston link --remove` prints it). If it's in a scheduler you can use, offer to delete it; otherwise tell them where it is. Until it's gone, their scheduler keeps starting runs.
