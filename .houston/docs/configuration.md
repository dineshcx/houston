# Configuration

Everything a team configures is in two places in the Houston repo: `houston.yml` and `cadences/` (plus, optionally, [`templates/issue.md`](#the-new-issue-summary)). Each person also has `houston.local.yml`. The easiest way to change any of them is to ask your agent in the Houston repo ("standup is at 9:30 now"); it edits, validates and shows you the change.

After editing by hand, run:

```sh
.houston/bin/houston validate    # lists every problem in plain words
.houston/bin/houston explain     # the setup in plain words
```

Unknown keys are refused, so a typo never silently turns something off.

## houston.yml

A full example. Only `houston`, `core`, `team` and `projects` are required; leave out anything you're happy with the default for.

```yaml
houston: 1
core: 0.1.0
template: acme/houston
team: { name: Web team, leads: [ana], members: [ana, raj] }
projects:
  storefront:
    name: Storefront
    repos:
      - { repo: acme/web, about: Customer-facing site }
      - acme/api
    cadences: [daily, sprint]
status:
  columns:
    - { label: todo, name: Todo }
    - { label: in-progress, name: Doing }
    - { label: in-review, name: Review }
    - { label: blocked, name: Blocked }
priority: { p0: Urgent, p1: High, p2: Medium, p3: Low }
rules:
  create_issue: review
  sub_issues: auto
  publish_runs: review_until_deadline
  publish_deadline: 15m
runs: { every: 3h, model: haiku, max_turns: 12 }
agents: { enabled: false }
```

### Top level

| Key | Required | Default | Allowed values |
| --- | --- | --- | --- |
| `houston` | yes | | `1` (the schema version this core reads) |
| `core` | yes | | the core version the team runs, like `0.1.0`. Must match `.houston/VERSION`; `houston update` bumps it. |
| `template` | no | | `owner/name` of the Houston template repo. Where `houston update` fetches new versions. |

### team

| Key | Required | Allowed values |
| --- | --- | --- |
| `team.name` | yes | any text |
| `team.members` | yes | GitHub usernames (letters, digits, dashes; no `@`) |
| `team.leads` | yes, at least one | GitHub usernames; each must also be in `members` |

### projects

A map from project id to project. At least one project.

| Key | Required | Allowed values |
| --- | --- | --- |
| project id (the map key) | | lowercase letters, digits and dashes, like `storefront` |
| `name` | yes | any text |
| `repos` | yes, at least one | each `{ repo: owner/name, about: "one line" }`, or just `owner/name`. A repo belongs to one project per team. `about` helps intake pick the right repo. |
| `cadences` | no | names of files in `cadences/` (without `.md`) |

### status

| Key | Default | Allowed values |
| --- | --- | --- |
| `status.columns` | Todo, In progress, In review, Blocked | a list of `{ label, name }`. `label` is one of `backlog`, `todo`, `in-progress`, `in-review`, `blocked`, `ready-for-agent`; `name` is what the board calls it. |

The status labels themselves are fixed (`status:todo`, `status:in-progress`, …) and the same in every repo, so two teams sharing a repo never fight. Teams only choose which columns to show and what to call them. An issue has one status at a time. `ready-for-agent` is reserved for later.

Run `houston labels sync` once ("set me up" does it for the first person, and again after adding a repo) to create the status, priority and kind labels in every team repo. A missing label is also created the first time Houston sets it in a repo.

### priority

| Key | Default |
| --- | --- |
| `priority.p0` | Urgent |
| `priority.p1` | High |
| `priority.p2` | Medium |
| `priority.p3` | Low |

The labels are always `p0`…`p3`; this sets their names. Issue kinds are fixed too: `kind:bug`, `kind:feature`, `kind:task`, `kind:investigation`.

### rules

What agents may do to issues without asking. Defaults in the table; see [Rules one by one](#rules-one-by-one).

| Key | Default | Allowed values |
| --- | --- | --- |
| `status` | `auto` | `auto`, `never` |
| `labels` | `auto` | `auto`, `never` |
| `create_issue` | `review` | `review`, `never` |
| `sub_issues` | `auto` | `auto`, `never` |
| `issue_comment` | `blockers_only` | `none`, `blockers_only`, `summary_changes` |
| `summary_on_issue` | `true` | `true`, `false` |
| `publish_runs` | `review_until_deadline` | `auto`, `review`, `review_until_deadline` |
| `publish_deadline` | `15m` | a duration |

Houston never closes issues; people do. There's no rule for it.

### runs

| Key | Default | Allowed values |
| --- | --- | --- |
| `runs.every` | `3h` | a duration. `houston run --if-due` skips if the last run was more recent; `houston schedule` suggests runs this often. |
| `runs.model` | `haiku` | the Claude model a run uses (passed to `claude --model`) |
| `runs.max_turns` | `12` | a whole number above 0 (passed to `claude --max-turns`) |

### agents

| Key | Default | Allowed values |
| --- | --- | --- |
| `agents.enabled` | `false` | `true`, `false`. Reserved for agents taking issues; nothing uses it yet. |

**Durations** are a number and a unit: `15m`, `3h`, `2d`, `2w`.

## Rules one by one

- **`status`**: `auto` lets runs and intake move issues between status columns (`status:in-progress` when you're clearly working on it, `status:in-review` for an open PR, `status:blocked`). `never` leaves status to people; the CLI refuses any status change.
- **`labels`**: `auto` lets agents set priority (`p0`–`p3`) and kind (`kind:bug`, …) labels. `never` refuses them. Houston only ever touches these and the status labels; every other label belongs to people.
- **`create_issue`**: `review` means new issues are proposed in an intake pull request and created after a person merges it. `never` makes intake refuse to propose any. Runs never create issues.
- **`sub_issues`**: `auto` links a new issue under its parent (an intake proposal's `parent:`) as a GitHub sub-issue, so work spanning repos gets one main issue. With `never`, the issue is created without the link.
- **`issue_comment`**: `none` means no comments at all; `blockers_only` lets runs comment only to say what blocks an issue; `summary_changes` lets them add a short note when a summary changed.
- **`summary_on_issue`**: `true` keeps a living summary at the top of each issue. Set `false` for public repos: summaries describe the team's private work.
- **`publish_runs`**: what happens to a run's draft. `auto` publishes right away. `review` waits until the person approves. `review_until_deadline` waits, then publishes on its own `publish_deadline` before the person's next cadence, marked "not reviewed".
- **`publish_deadline`**: how long before the cadence time an untouched draft publishes. With a 10:00 standup and `15m`, it goes out at 09:45.

## Cadence files

One file per cadence: `cadences/<name>.md`. The name (without `.md`) is what projects list in `cadences:`. Every `.md` file in `cadences/` with a lowercase name (like `daily.md`) is read as a cadence, so keep other files out of it.

```markdown
---
title: Daily standup
schedule: "Mon-Fri 10:00"
period: day
writers: [runs, people]
page: |
  # {{title}}, {{period}}

  ## Notes

  ## Decisions

  ## Action items
---
## Done
- owner/repo#123 What finished since the last standup, in one line

## Doing
- owner/repo#123 What is moving now and the next step

## Blocked
- owner/repo#123 What it's waiting on, and who (@username)

## Other
- Real work that matches no issue
```

The front matter says when and how long; the **body** is the shape each person's section follows. A run shows it to its agent as the template to fill. With an empty body, runs use Done, Doing, Blocked and Other.

| Key | Default | Allowed values |
| --- | --- | --- |
| `title` | the file name | any text |
| `schedule` | required | days and a time; see below |
| `period` | `day` | `day`, `week`, `sprint`, `month` |
| `sprint_start` | required for sprints | `YYYY-MM-DD`, the first day of any sprint |
| `sprint_length` | `2w` | a duration, like `1w`, `2w`, `3w` |
| `writers` | `[runs, people]` | a list of `runs` and/or `people`. Without `runs`, runs don't write sections for this cadence. |
| `page` | Agenda, Notes, Decisions, Action items | the Notes (`_page.md`) each new period starts with |

### Schedule

Days, a space, then a 24-hour time. The time is read in **each person's own timezone**.

| Example | Means |
| --- | --- |
| `"Mon-Fri 10:00"` | Monday to Friday at 10:00 |
| `"Mon 09:30"` | Mondays at 09:30 |
| `"Mon,Thu 16:00"` | Mondays and Thursdays at 16:00 |
| `"daily 09:00"` or `"every day 09:00"` | every day |
| `"weekdays 09:00"` | Monday to Friday |

The schedule is when the meeting happens. Houston uses it to decide when a draft publishes and to suggest run times. A `day` cadence only has a page on its scheduled days.

### Periods

A period is named by its first day, and that's its folder: `projects/<project>/<cadence>/<YYYY-MM-DD>/`.

| `period` | One page per | First day |
| --- | --- | --- |
| `day` | day | that day |
| `week` | week | Monday |
| `sprint` | sprint | `sprint_start`, then every `sprint_length` |
| `month` | month | the 1st |

A period is frozen once the next one has started.

### The page template

`page:` is the text a new period's Notes (`_page.md`) start with (created by runs, `houston page`, or the app). It may use three variables:

- `{{title}}`: the cadence's title
- `{{period}}`: the period's first day, like `2026-11-13`
- `{{project}}`: the project id, like `storefront`

Any other `{{…}}` is refused by `houston validate`.

## The new-issue summary

Every issue Houston creates starts with a living summary from `.houston/templates/issue.md`. To change it, copy that file to `templates/issue.md` in the Houston repo and edit it; the team's file wins. Only the block between `<!-- houston:summary -->` and `<!-- /houston:summary -->` is used, and it may use only `{{goal}}`, `{{raised_by}}` and `{{next_step}}`. `houston validate` checks it. There is one template for every kind of issue.

## houston.local.yml

Personal to one laptop and gitignored. `houston link` writes it; you can edit it.

```yaml
user: ana
timezone: Europe/London
repos:
  acme/web: /Users/ana/code/web
  acme/api: null
schedule: "crontab, Mon–Fri 09:00, 09:45, 12:00, 15:00, 18:00"
```

| Key | What |
| --- | --- |
| `user` | your GitHub username (from `gh`) |
| `timezone` | an IANA timezone like `Asia/Kolkata` or `Europe/London`; cadence times are read in it |
| `repos` | each team repo → its folder on this laptop, or `null` (or `none`) for "not on this machine". `~/` is expanded. |
| `schedule` | one sentence saying which scheduler runs `houston run` and when. Recorded by `houston schedule --set`; `houston doctor` checks it's there. |

Your run state (last run, current draft, the core you trusted) is in `.houston-local/state.json`, also gitignored.

## Presets

Ready-made cadences in `.houston/presets/`. Setup copies the ones you pick into `cadences/`; they combine.

| Preset | Cadences |
| --- | --- |
| `daily-standup` | `daily.md`: Mon–Fri 10:00, one page per day |
| `weekly-sync` | `weekly.md`: Mondays 10:00, one page per week |
| `sprints-with-kpis` | `sprint.md`: two-week sprints planned Mondays 10:00; `kpi.md`: a weekly KPI check, Mondays 11:00 |

Each preset's `README.md` says when to pick it. To add one later, ask your agent ("add a weekly KPI check"), or copy the file into `cadences/`, add its name to each project's `cadences:` and run `houston validate`.
