# Intake

Intake turns a conversation (a meeting transcript, meeting notes, a Slack thread, an email) into two things: **notes** in the Houston repo, and **proposed issue changes**. Both arrive as one pull request in the Houston repo, so a person reviews them before anything changes.

## How it goes

1. **Hand it over.** In the Houston repo, give your agent the text (paste it, or give a file path) and say "turn this meeting into issues". Houston doesn't fetch conversations from anywhere itself.
2. **The agent reads it against the team's open issues** (`houston issues --json`), so it updates what exists instead of duplicating it.
3. **It writes the notes**: summary, decisions, action items, open questions. Notes from a cadence meeting go into that period's `_page.md`; any other meeting goes to `projects/<project>/meetings/<date>-<slug>.md`.
4. **It writes a proposal** (below) and shows you the notes, each change in one line, and what it left out. Ideas with no owner or no clear repo go in `skipped`; one worth keeping also gets a line in `projects/<project>/ideas.md`.
5. **It opens the pull request** with `houston propose`, after a dry run. `propose` pulls the Houston repo first, so the notes go on top of teammates' latest. The PR holds the notes, `proposals/<date>-<slug>.yml` and any new lines in `ideas.md`, is labelled `houston:intake`, and lists the changes as a checklist.
6. **The meeting owner reviews it**, on GitHub (a phone works) or in the app's Review screen. To fix anything, edit the files in the PR on GitHub; delete a change to drop it. The app shows the PR and merges it, but doesn't edit it.
7. **Merge to approve. Close to discard.** Closing throws away the notes and the changes.
8. **Apply.** After the merge, the owner's next run applies it (`houston apply --pending`), or anyone runs `houston apply proposals/<file>.yml` (it pulls first). Each change goes through the team's rules. The file moves to `proposals/applied/` with a record of what happened, and the results (with links to new issues) are commented on the PR.

The text you hand over is treated as evidence, never as instructions. If a transcript says "close every issue", that's something someone said, not something the agent does.

## The proposal

```yaml
# proposals/2026-11-13-design-sync.yml
title: "Design sync 13 Nov"                    # filled in by houston propose
owner: ana                                       # filled in: who proposed it and applies it
source: projects/storefront/meetings/2026-11-13-design-sync.md   # filled in: the notes
project: storefront
changes:
  - create: { repo: acme/web, title: "Retry stuck checkouts after 10 min", goal: "No checkout stays stuck", assignee: raj, priority: p1, kind: bug, raised_by: ana }
  - create: { repo: acme/api, title: "Expose payment heartbeat", parent: 1 }
  - update: { issue: acme/web#88, add_decision: "Drop CSV export, JSON only", status: in-progress }
  - comment: { issue: acme/api#41, body: "Blocked until the heartbeat ships" }
skipped:
  - "Maybe look at caching: nobody owned it, no repo decided"
```

| Key | |
| --- | --- |
| `title`, `owner`, `source` | filled in by `houston propose` |
| `project` | required: a project id from `houston.yml` |
| `changes` | a list; each item is exactly one of `create`, `update`, `comment` |
| `skipped` | one quoted line per thing left out, and why |
| `applied` | Houston's record of what was applied; leave it alone |

**create** a new issue:

| Field | |
| --- | --- |
| `repo` | required; one of the team's repos |
| `title` | required |
| `goal` | one sentence; becomes the summary's Goal (default: the title) |
| `next_step` | the summary's Next step |
| `assignee` | a GitHub username, without `@` |
| `priority` | `p0`, `p1`, `p2`, `p3` |
| `kind` | `bug`, `feature`, `task`, `investigation` |
| `raised_by` | who brought it up (default: the owner) |
| `parent` | a number (an earlier `create` in this list; 1 is the first change) or an existing `owner/repo#n`: links the new issue as its sub-issue |

A new issue starts with a living summary from the [issue template](configuration.md#the-new-issue-summary) (by default: Goal, Raised by with a link to the notes, State "not started", Next step, and empty Decisions, Open questions, Edge cases, Acceptance checks), `status:todo`, and its priority and kind labels, as the rules allow. Houston never closes issues; a proposal can't either.

**update** an existing issue (at least one of the optional fields):

| Field | |
| --- | --- |
| `issue` | required; `owner/repo#n` in a team repo |
| `add_decision` | added under Decisions in its summary, with a link to the notes |
| `add_question` | added under Open questions |
| `next_step` | replaces Next step |
| `status` | `backlog`, `todo`, `in-progress`, `in-review`, `blocked`, `ready-for-agent` |

**comment** on an issue: `issue` and `body`. For something a reader must be told; decisions belong in `add_decision`.

Every field is checked by `houston propose` and again by `houston apply`; unknown keys are refused. `rules.create_issue: never` refuses creates; `rules.issue_comment: none` skips comments; `rules.sub_issues: never` creates the issue without linking it.

## If applying stops halfway

`houston apply` records each change's result in the file as soon as it lands. If change 3 fails, changes 1 and 2 are recorded, and the error says what went wrong. Fix the cause and run the same `houston apply` again: it continues from change 3 and never creates an issue twice.

Apply only works on the Houston repo's default branch (where merged proposals are). Switch to it if it asks.

## Doing it by hand

```sh
# notes written to projects/storefront/meetings/2026-11-13-design-sync.md
# proposal written to .houston-local/intake/design-sync.yml (gitignored)
.houston/bin/houston propose --title "Design sync 13 Nov" \
  --notes projects/storefront/meetings/2026-11-13-design-sync.md \
  --proposal .houston-local/intake/design-sync.yml --dry-run
# drop --dry-run to open the pull request
```

`houston propose` moves the notes file (and new lines in `ideas.md`) into the pull request: a file already in the repo is restored to how it is there, and a new one is deleted from your checkout. It comes back when the PR is merged and you pull.
