# Concepts

How Houston's pieces fit together. For one-line definitions, see [GLOSSARY.md](../../GLOSSARY.md).

## The building blocks

**Team.** The people in `houston.yml` → `team`: a name, `members` (GitHub usernames) and `leads` (members who own the setup). One Houston repo per team.

**Project.** A thing the team ships, made of one or more code repos. `storefront` might be `acme/web` and `acme/api`. Each project lists the cadences it uses.

**Repo.** A GitHub code repo, listed under exactly one project. Its issues are the team's issues. Each person links the repos they have on their laptop with `houston link`.

**Cadence.** A recurring page, defined in `cadences/<name>.md`: when it happens (`Mon-Fri 10:00`), how long one page lasts (a day, week, sprint or month), and the shape of each person's section. Presets give you a daily standup, a weekly sync, and sprints with a KPI check.

**Source.** Where evidence of work comes from. Runs read GitHub activity, each linked repo's local git work, the inbox file in each linked repo, and Claude Code sessions in those repos. Conversations (transcripts, Slack threads, email) come in through intake.

**Rule.** What agents may do to issues without asking: move status, set labels, propose issues, link sub-issues, comment, keep summaries. Set in `houston.yml` → `rules`, enforced by the CLI. Houston never closes issues; people do.

## Where everything lives

| What | Where | Written by |
| --- | --- | --- |
| Team setup | `houston.yml`, `cadences/` in the Houston repo | people (usually by asking their agent) |
| Issues | the code repos on GitHub | people, runs, intake (through the CLI) |
| Living summaries | top of each issue's body, between markers | runs, intake, `houston summary --set` |
| Cadence pages | `projects/<project>/<cadence>/<period>/` | `_page.md` (the **Notes**): people; `<user>.md` (that person's **Update**): that user's runs |
| Day logs | `people/<user>/<YYYY-MM-DD>.md` | that user's runs |
| Meeting notes | the period's `_page.md`, or `projects/<project>/meetings/` | intake |
| Ideas with no repo yet | `projects/<project>/ideas.md`, one per line | intake |
| Intake proposals | `proposals/`, then `proposals/applied/` | `houston propose`, `houston apply` |
| Team skills | `skills/<name>/SKILL.md` | people |
| New-issue summary (optional) | `templates/issue.md`, overriding `.houston/templates/issue.md` | people |
| Houston itself | `.houston/` | `houston update` |
| Your settings | `houston.local.yml` (gitignored) | `houston link` |
| Your draft and run state | `.houston-local/` (gitignored) | `houston run`, `houston draft` |
| Your approved copy of the core | `.houston-local/core/` (gitignored) | `houston trust` |
| Repo pointer and inbox | `.houston`, `.houston-inbox.md` in each code repo, hidden by `.git/info/exclude` | `houston link`; your agent appends to the inbox |

Nothing is ever committed to a code repo.

## The living summary

Every issue Houston works on gets a block at the top of its body:

```markdown
<!-- houston:summary -->
**Goal:** Checkout retries back off instead of hammering the API
**Raised by:** @ana in Daily standup 13 Nov
**State:** backoff merged; the retry-after header isn't read yet
**Next step:** read retry-after from the API (@raj)

### Decisions
- Cap retries at 5 (Design sync 12 Nov)
### Open questions
- [ ] Do retries count against quota? (@ana)
### Edge cases
### Acceptance checks
- [ ] No more than 5 requests per failed checkout
<!-- /houston:summary -->

The original issue description, as people wrote it.
```

- Runs rewrite the block only when the goal, state, a decision or the next step changed.
- Text outside the markers is never touched.
- If someone else edited the issue body in the last 10 minutes, Houston leaves the summary alone rather than overwrite them.
- `rules.summary_on_issue: false` turns summaries off (recommended for public repos, since summaries describe private work).
- A new issue's summary comes from `templates/issue.md` if the team has one, otherwise `.houston/templates/issue.md`. It may use only `{{goal}}`, `{{raised_by}}` and `{{next_step}}`.

## One file per writer

Each file in the Houston repo has one kind of writer. Ana's runs write only her Update (`ana.md`) and `people/ana/…`; people write the Notes (`_page.md`). So runs from ten laptops push to the same repo all day and never conflict. If a push is refused because someone pushed first, Houston pulls and pushes again.

## Frozen periods

A period is open until the next one starts. After that it's **frozen**: runs refuse to write to it and the app shows it read-only. Nothing marks it; Houston works it out from the dates. Yesterday's standup page stays what it was at standup.

## Drafts

A run never publishes straight to the team by default. It writes a **draft**, `.houston-local/draft.md`, that you can read and edit:

```markdown
<!-- houston draft · window 2026-11-13 06:00 → 09:00 · publishes 2026-11-13 09:45 unless you approve or hold it -->

<!-- houston:day 2026-11-13 -->
## Done
- acme/web#12 Checkout retries now back off (PR #40 merged)
...

<!-- houston:page storefront/daily/2026-11-13 -->
(your section of today's standup)

<!-- houston:summary acme/web#12 -->
**Goal:** …

<!-- houston:labels acme/web#12 -->
status:in-review
```

Each `<!-- houston:… -->` line starts a section; edit the text under it, or delete a whole section to drop it. Then:

- `houston publish` publishes it now.
- `houston draft hold` keeps it until you `houston draft release` it.
- Doing nothing: with the default `rules.publish_runs: review_until_deadline`, it publishes on its own 15 minutes (`rules.publish_deadline`) before your next cadence, marked "not reviewed" on the page.
- If you edited it, it still publishes at the deadline (without "not reviewed"), and later runs don't replace your edits. Only a held draft waits past the deadline.

See [runs.md](runs.md) for the whole run.

## The trusted core

Every teammate's runs execute Houston's code unattended, so anyone who can push to the Houston repo could otherwise run code on all their laptops. Instead, each person approves the core with `houston trust`, which copies `.houston/` to `.houston-local/core/` (gitignored, one per laptop). Schedulers and agents run that copy, `.houston-local/core/bin/houston`, which is what `houston schedule` prints.

When a pull brings a change to `.houston/` or to the team's `skills/run/SKILL.md`, runs stop and say so until the person reviews it (`git log -p -- .houston skills/run`, and `git diff -- .houston skills/run` for uncommitted changes) and runs `houston trust` again. Typing `.houston/bin/houston` yourself in the repo is fine: you're there to see what it does.
