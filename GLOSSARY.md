# Glossary

The words Houston uses, in one place. Docs, skills and the CLI all use them this way.

**Houston repo.** This repo: your team's copy of the Houston template. It holds the team's setup (`houston.yml`, `cadences/`), its notes (pages, day logs, meeting notes) and intake proposals. One per team. Not to be confused with a code repo.

**Code repo.** A GitHub repo where the team's code and issues live, like `acme/web`. Listed under a project in `houston.yml`. Houston reads and updates its issues but never commits to it.

**Project.** A group of code repos that ship one thing, like `storefront` with `acme/web` and `acme/api`. A team has one or more projects; a repo belongs to exactly one project per team. Each project picks its cadences.

**Cadence.** A recurring page: daily standup, weekly sync, sprint, KPI check. One file in `cadences/`, saying when it happens (`schedule`), how long a page lasts (`period`) and the shape each person's section follows. Not to be confused with a run, which is when a laptop does the work.

**Period.** One stretch of a cadence: a day, a week, a sprint or a month. Its folder is named by its first day, like `projects/storefront/daily/2026-11-13/`. A period is **frozen** once the next one has started: its files don't change after that.

**Page.** Everything in one period's folder: `_page.md` (the team's notes, written by people) and one file per person (`ana.md`, written only by Ana's runs).

**Day log.** One person's record of a day: `people/<user>/<YYYY-MM-DD>.md`, written by their runs. Not tied to any project.

**Run.** `houston run` on one person's laptop, started by their own scheduler every few hours. It reads their recent work and drafts their updates. Not to be confused with a cadence (when the page is due) or the run skill (the instructions the run's agent follows).

**Draft.** What a run wants to publish, as one editable file: `.houston-local/draft.md`. The person can edit it, approve it (`houston publish`), hold it, or leave it; by default it publishes on its own 15 minutes before the next cadence, marked "not reviewed".

**Living summary.** A short block at the top of an issue's body, between `<!-- houston:summary -->` and `<!-- /houston:summary -->`: goal, who raised it, state, next step, decisions, open questions, edge cases, acceptance checks. Runs keep it current. Text outside the markers belongs to people and is never touched.

**Inbox.** `.houston-inbox.md` in each linked code repo: one line per note an agent leaves while working (`- 14:05 fixed the retry bug (acme/web#12)`). Hidden from git. The next published run uses the lines and removes them. Not to be confused with intake.

**Intake.** Turning a conversation (meeting transcript, Slack thread, email) into notes and issue changes, opened as one pull request in the Houston repo. Say "turn this meeting into issues" to your agent.

**Proposal.** The issue changes intake suggests, as a file: `proposals/<date>-<slug>.yml`. Merging the intake pull request approves it; `houston apply` then makes the changes. Closing the pull request throws it away.

**Rules.** What agents may do to issues without asking (`rules:` in `houston.yml`): change status, create issues, comment, and so on. The CLI enforces them; an agent can't skip them.

**Core.** The `.houston/` folder: the CLI, the app, the core skills, presets and docs. Every team runs the same core; `houston update` replaces it. Teams don't edit it.

**Preset.** A ready-made set of cadence files in `.houston/presets/` (daily standup, weekly sync, sprints with KPIs). Setup copies the ones a team picks into `cadences/`.
