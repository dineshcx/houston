# The app

A local web app for running standup, reviewing your draft and moving issues. Everything in it is also in files and on GitHub; nobody has to use it.

```sh
.houston/bin/houston app            # serves http://127.0.0.1:4317 and opens it (on macOS)
.houston/bin/houston app --no-open  # don't open the browser
```

It runs only on your laptop (`127.0.0.1`), answers only its own pages, and changes issues and drafts through the `houston` CLI, under the same rules as everything else. It re-reads `houston.yml` and `cadences/` on every request, so edits show without a restart.

## Finding your way

The sidebar has the five screens, then your **Projects** with each cadence under them (one link per project × cadence, opening the current period; a team with one project lists its cadences under **Pages**), then **Setup**. Its footer shows how fresh **your last run** is (click for its sources and note), the theme (system, light, dark) and the keyboard shortcuts. Drag its edge to resize it; `[` collapses it to icons.

Every screen has a top bar with its title and actions. While data loads you see a skeleton of the screen, never the previous one; GitHub-backed screens say how old their data is ("Fetched 4m ago", amber after 10 minutes) and `r` fetches again. If something fails, the screen says what and how to retry, and keeps what it already had. If the app itself stops, you see "The Houston app stopped" and it reconnects on its own once you run `houston app` again.

Links are stable, so you can share or bookmark them: `#/today`, `#/draft`, `#/board`, `#/review`, `#/people`, `#/setup`, `#/p/<project>/<cadence>` (current period), `#/p/<project>/<cadence>/<YYYY-MM-DD>`, `#/issue/<owner>/<repo>/<n>`.

## Today

The home screen: what needs you, in one place.

- **Your draft**, if there is one: where it goes, a countdown to when it publishes on its own (amber under 15 minutes, red under 5), **Review draft** and **Approve & publish** (`⌘↵`). If your last run failed, that's said first, with the command to see why.
- **Today's pages**: every project × cadence with a period open today, with its meeting time, a bar with one segment per member (green published, amber not reviewed, red a source failed, grey no update yet) and how many lines are Blocked. A page no run has made yet can be started from here.
- **Needs attention**: intake pull requests waiting, teammates whose runs failed or went quiet, your issues in Blocked.
- **Getting started**, until it's done: setup valid, repos linked, core trusted, schedule set, first run, teammates, each with the command to copy.

## Pages

One period of a cadence: the list of periods on the left, the **Notes** in the middle, the **Updates** on the right (on a narrower window, `u` or the **Updates** button opens them as a sheet).

- **Notes** are a rich editor (headings, lists, checkboxes, bold, italic). Issue references like `acme/web#12` show as live chips with the issue's status and title; `⌘K` (or **Link issue**) searches the team's issues and inserts one. It saves as you type: the file on your laptop is written a moment after you stop, and Houston commits and pushes it about 30 seconds later, when you leave the page, on `⌘S`, and when the app stops. The top bar says where it is: Editing…, Saved, Synced to GitHub, or Couldn't sync · Retry. Opening a page never changes it.
- If a teammate changed the same Notes meanwhile, nothing is overwritten: you're shown "This page changed elsewhere" with **Reload theirs** or **Keep mine** (your text is also kept in `.houston-local/conflicts/`).
- **Updates**: a **Blocked** roll-up of everyone's Blocked lines on top, then each member's update, problems first. Each card says how its run went before you read it: the run time and "ok", which sources failed (with a band saying the update may be missing work), and "Not reviewed" if it published on its own. A member with no update says why: never ran, last run failed, not due yet, in your draft, no run since a day. Filter with **All / Blocked / Problems** (`b` for Blocked). New updates arrive by themselves every minute.
- **Action items** (unchecked boxes in the Notes) are listed under the document.
- A page that doesn't exist yet can be started with **Start the page** (it's made from the cadence's headings; if it already exists nothing happens). A past period is **Frozen**: read-only, because the next one has started.
- **Copy summary** copies the period as markdown (blockers, counts, Notes) for Slack or email.

## My draft

What your run will publish, shown the way it will appear, grouped by where it goes: **Standup updates** (one per page), **Issue summaries** (with **Compare** to see what changes in the living summary), **Issue changes** (labels as from → to, comments) and your **Day log** (collapsed).

- **Edit** on a card edits just that part as text; it saves as you type, and an edited draft is never replaced by a later run. **Remove** drops a part (with Undo).
- **Approve & publish** (`⌘↵`) publishes now and shows where it went, with links to the pages.
- **Hold** (`h`) keeps it back past its deadline; **Release** lets it publish again.
- **Discard** is in the `⋯` menu and asks first; your next run covers that time again. **Edit raw file** is there too, for anything the cards can't express.

## Board

The team's open issues, as a list grouped by status (default) or as columns (`v`). Filter by project, person (`Me` first) or text (`/`); filters are part of the link.

- `j`/`k` move, `Enter` opens the issue, `s` changes its status, `o` opens it on GitHub. With the mouse, the status icon opens the same menu, and cards can be dragged between columns.
- A move shows at once, with **Undo** in the toast; if GitHub refuses it, it moves back and says why.
- **No status** is collapsed by default: open it to triage.
- The issue panel docks on the right (drag its edge to resize): status, priority, assignees, labels, the **living summary** as labelled rows, the description and comments.

## Review

Open intake pull requests in the Houston repo (labelled `houston:intake`). Each shows its **proposed changes** first (new issues with assignee, priority and kind; updates and comments with the target issue's chip), then what was left out, then the meeting notes (collapsed).

- **Merge** (`m`) asks first, then approves it. The owner's next run applies the changes (or anyone runs `houston apply`). If apply would refuse the proposal, Merge is disabled and the reason shown.
- To change anything, edit the pull request on GitHub; to discard one, close it there.

## People

One row per member, problems first: their health in plain words (last run failed, a source failed, no run since a day, never ran), a square per open page for today's update, their Blocked lines with links to the page, and their newest day log. Teammates' failed runs can't show here (a failed run publishes nothing); quiet days and failed sources in their last update do.

## Setup

How the team works, in sections: members, projects with their repos and cadences, statuses, what agents may do, how runs publish, whether `houston.yml` and `cadences/` are valid, and **Your laptop** (`houston doctor`'s checks, with the fix for each). **Plain text** shows `houston explain`. To change the setup, ask your agent in the Houston repo; there are example requests to copy.

## Keyboard

`?` shows every shortcut. Everywhere: `⌘K` command palette (in the Notes it links an issue; `⌘⇧K` opens the palette there), `1`–`5` Today, My draft, Board, Review, People, `g` then `t`/`d`/`b`/`r`/`p`/`s`, `[` sidebar, `t` theme, `r` refresh, `Esc` closes. On a page: `p`/`n` previous/next period, `.` current, `e` edit the Notes, `u` updates, `j`/`k` between updates, `b` blocked only, `⌘S` sync now.

## For contributors

The frontend is in `app/public/`: plain ES modules, no build step, no runtime dependencies.

| File | What it is |
| --- | --- |
| `index.html`, `theme.js`, `style.css` | the shell, the no-flash theme script, and the whole visual system (Mission Control's tokens and components) |
| `js/app.js` | the frame: sidebar, routing, keyboard, ⌘K palette, shortcut sheet, polling, resizable panels, "app stopped" |
| `js/api.js` | fetch wrapper (JSON writes, errors with their status and extra fields, server-down detection, last-answer cache) |
| `js/ui.js` | `html` templating (escapes everything), icons, status/priority icons, avatars, time, countdown, toast, dialogs, menus |
| `js/markdown.js` | the small markdown renderer used outside the editor (issue refs become chips) |
| `js/issues.js` | the shared board store, issue chips, the issue panel, status moves with undo, the issue picker |
| `js/editor-host.js` | loads `vendor/editor.js` lazily on page screens, with a plain textarea fallback |
| `js/screens/*.js` | one file per screen; each exports `mount(main, route)` returning `{ refresh, key, leave, update, help, poll }` |

The CSP (`default-src 'self'; img-src 'self' data:`) allows no inline scripts, no `style=""` attributes and no external images: colours come from classes (avatars use `.hue-0…11`), sizes set at runtime go through `element.style` / CSS variables, and avatars are initials. `test/app.test.ts` checks the files for these and that every imported module is served. The API the screens call is routed in `app/server.ts` and implemented in `app/api/` (one file per area).
