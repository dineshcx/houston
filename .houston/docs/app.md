# The app

A local web app for reading and acting on the team's context. Everything in it is also in files and on GitHub; nobody has to use it.

```sh
.houston/bin/houston app            # serves http://127.0.0.1:4317 and opens it (on macOS)
.houston/bin/houston app --no-open  # don't open the browser
```

It runs only on your laptop (`127.0.0.1`), answers only its own pages, and changes issues and drafts through the `houston` CLI, under the same rules as everything else. It re-reads `houston.yml` and `cadences/` on every request, so edits show without a restart.

Switch screens from the left rail or with the keys `1` to `6`. The rail also shows the team, you, and how fresh your last run is.

## 1. Today

Today's cadence page for a project: pick the project and the cadence (Daily standup, Sprint, …), and step to earlier or later periods.

- **Team notes**: the period's `_page.md`. Edit it, preview it, and **Save** (it commits and pushes).
- **Everyone's update**: each member's section from their runs, with its footer: run time, each source's health, and "not reviewed" if it published on its own. Members with no section yet show "No update yet".
- **Create today's page** if the current period has none yet.

A past period is **Frozen**: read-only, because the next one has started.

## 2. Board

Open issues across the team's repos, in the team's status columns plus "No status". Filter by project or person.

- Move a card by dragging it, or with the status menu on the card. It changes the issue's `status:` label on GitHub.
- Click a card to read the issue: its living summary, labels, assignees and the rest of its body.
- **Refresh** (or `r`) fetches from GitHub again; otherwise the board is cached for a minute.

## 3. Review

Open intake pull requests in the Houston repo (labelled `houston:intake`). Each shows its notes and its proposed changes as a list.

- Read it, and open it on GitHub to edit either file.
- **Merge** approves it. The owner's next run applies the changes (or anyone runs `houston apply`).
- To discard one, close it on GitHub.

## 4. My draft

Your run's current draft, if there is one, and when it publishes.

- Edit the text and **Save**. An edited draft is never replaced by a later run.
- **Approve & publish** publishes it now.
- **Hold** keeps it back past its deadline; **Release** lets it publish again.
- **Discard** throws it away; your next run covers that time again.

## 5. People

Each team member: their newest day log, their newest page section with its footer, and for you, your last run. Anyone with no run data in the last day is flagged, so a quiet laptop is visible rather than looking like a quiet day.

## 6. Setup

How the team works, in plain words (`houston explain`), and whether `houston.yml` and `cadences/` are valid (`houston validate`). To change the setup, ask your agent in the Houston repo.
