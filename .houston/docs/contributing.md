# Contributing to Houston

For people improving Houston itself: the CLI, the app, the core skills, presets and these docs.

## Template repo and team repos

Houston is a template repo. Each team clicks **Use this template** and gets its own Houston repo with a copy of `.houston/` (the core) plus its own `houston.yml`, cadences, notes and skills.

Changes flow one way: you improve the core in the **template repo** and release a version; each team brings it in with `houston update`, which opens a pull request replacing their `.houston/`. Teams never edit `.houston/` in their own repo, and nothing flows back automatically. If you fixed something in your team's copy, make the same change in the template repo.

Only `.houston/` is core. The template's top-level files (`README.md`, `AGENTS.md`, `GLOSSARY.md`, `templates/`, `.claude/skills/`, `.github/`) are copied once when a team is created; `houston update` doesn't refresh them. Put anything every team must get after creation in `.houston/`.

## Code layout

Everything is in `.houston/`: Bun and TypeScript, no runtime dependencies (only Bun and Node's standard library).

| Path | What goes there |
| --- | --- |
| `bin/houston` | the entry script: runs `src/cli.ts` with Bun, passing Houston's own empty `bunfig.toml` so a `bunfig.toml` at the repo root can't preload code |
| `src/cli.ts` | the command list, in the order `houston help` shows it, and error printing |
| `src/command.ts` | the `Command` type every command exports |
| `src/commands/<name>.ts` | one file per command: parse flags, call `lib/`, print plain-word results. Thin. |
| `src/lib/` | the logic, shared by commands and the app: config and its validator (`config.ts`), cadences and dates (`cadence.ts`), GitHub through `gh` (`github.ts`), the issue rules (`issues.ts`), evidence and matching (`evidence.ts`), the draft (`draft.ts`), proposals (`proposals.ts`), setup (`setup.ts`), core trust (`core.ts`), git in the Houston repo (`repo.ts`), state (`state.ts`), paths (`paths.ts`) |
| `app/server.ts`, `app/public/` | the local app: a JSON API on 127.0.0.1 and three static files |
| `skills/<name>/SKILL.md` | core skills agents follow: set-me-up, change-setup, intake, run |
| `templates/issue.md` | the living summary new issues start with (a team's `templates/issue.md` overrides it) |
| `presets/<name>/` | cadence files a team can start from, with a README each |
| `docs/` | these docs |
| `test/<area>.test.ts` | one test file per area |
| `VERSION` | the core version |

## The principle: agents decide, the CLI does

Agents (in skills and in runs) decide *what* to say: which issues changed, what the summary says, what a meeting decided. The `houston` CLI does every write and every check: it validates input, enforces the team's rules, touches only the team's repos and the core labels, and never overwrites a person's fresh edit. Unattended runs may only call `houston draft add` (text on stdin) and `houston issues`.

So when you add behaviour:

- A rule that must always hold goes in code (`src/lib/`), never only in a skill.
- A judgement call (what's worth writing, how to phrase it) goes in a skill.
- The app calls the CLI or `src/lib/` for issue changes; it never re-implements a rule.

Other standards: simple, boring, readable code; a short header comment per file saying what it is; comments explain why. User errors throw `HoustonError` (from `src/lib/util.ts`) with a plain-word message that says what to do next; it prints without a stack trace.

## The trust model

Every teammate's scheduler runs Houston unattended. Anyone who can push to a team's Houston repo could otherwise run code on all their laptops. So:

- `coreHash()` (`src/lib/core.ts`) hashes every file in `.houston/` except `node_modules/`, `test/`, `docs/` and `.DS_Store`, plus the team's `skills/run/SKILL.md` (an unattended run follows it).
- `houston trust` copies those same files to `.houston-local/core/` (gitignored) and records the hash in `.houston-local/state.json` → `trusted_core`. `houston link` does this the first time.
- Schedulers and the global block run the copy, `.houston-local/core/bin/houston` (`paths.bin`, what `houston schedule` prints), and a run's agent may only call that copy. So a `git pull`, even one in the middle of a run, can't bring in code that runs before the person has looked at it.
- `houston run` refuses to start when the repo's hash differs from the trusted one, before and after it pulls. The person reviews the change (`git log -p -- .houston skills/run`) and runs `houston trust`.
- People typing `.houston/bin/houston` in the repo run the repo's core directly; that's their choice in front of the code.
- The run's agent is locked down (`startAgent` in `src/commands/run.ts`): an empty working folder, only the Bash tool, only `draft add` and `issues` from the trusted copy, no MCP servers, no user or project settings, and `draft add --file` is refused during a run.
- `houston update` opens a pull request for review; teams should protect `.houston/`, `houston.yml`, `cadences/` and `skills/` with CODEOWNERS (`.github/CODEOWNERS.example`).

Any change to a file in `.houston/` other than docs and tests makes every teammate run `houston trust` once after updating.

## Running tests and typecheck

```sh
cd .houston
bun install                 # dev tools only: typescript, @types/bun
bun test                    # all tests
bun test test/run.test.ts   # one area
bunx tsc --noEmit -p .      # typecheck
```

CI (`.github/workflows/houston.yml`) runs the same, plus `houston validate` when the repo has a `houston.yml`.

Tests never touch the network or your real home folder. They use these environment variables:

| Variable | Effect |
| --- | --- |
| `HOUSTON_ROOT` | use this folder as the Houston repo |
| `HOUSTON_FAKE_GITHUB` | a JSON file that stands in for GitHub (see `FakeData` in `src/lib/github.ts`) |
| `HOME` | a temp folder, so `~/.claude/` and scans stay out of your real one |
| `HOUSTON_AGENT` | a shell command run instead of `claude -p`; it gets the prompt on stdin and `HOUSTON_BIN` in its environment |
| `HOUSTON_SCAN_DIRS` | extra folders `houston link` searches, colon-separated |
| `HOUSTON_NO_NOTIFY` | no macOS notification from runs |
| `HOUSTON_TEMPLATE_URL` | the git URL `houston update` clones instead of GitHub |

When a test runs the CLI as a subprocess, run `bun <path>/.houston/src/cli.ts …` with those variables set.

## Adding a command

1. Create `src/commands/<name>.ts`:
   ```ts
   // houston <name>: one line saying what it does and why.
   import { parseArgs } from "node:util";
   import type { Command } from "../command";

   export default {
     summary: "What it does, in one line for houston help",
     usage: "houston <name> [--flag]\n\n  --flag   what it does",
     run(args) {
       const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: { flag: { type: "boolean" } } });
       // call src/lib/, print plain-word results
     },
   } satisfies Command;
   ```
2. Register it in `COMMANDS` in `src/cli.ts`, in the right group.
3. Put the logic in `src/lib/` if anything else (the app, another command) could use it.
4. Add tests to the area's `test/<area>.test.ts`.
5. Add it to `docs/cli.md`, with its usage copied from `houston help <name>`.

## Releasing a core version

1. Bump `.houston/VERSION` (like `0.1.0` → `0.2.0`).
2. Merge to the template repo's default branch and tag it: `git tag v0.2.0 && git push --tags`.
3. Teams run `houston update` (the default branch) or `houston update --ref v0.2.0`. It only proceeds when the template's `VERSION` is newer than theirs, then opens a pull request replacing `.houston/` and bumping `core:` in their `houston.yml`.
4. Say in the release notes what changed, so CODEOWNERS can review the update and each person knows what they're trusting.

If a release changes the `houston.yml` schema, the change must keep old files valid or come with clear validation errors telling teams what to change.
