# Your team's skills

Houston's core skills live in `.houston/skills/` and are replaced by `houston update`. Put your team's own versions here, so they survive updates.

- **Override a core skill**: copy `.houston/skills/<name>/SKILL.md` to `skills/<name>/SKILL.md` and edit it. Yours wins from then on; `houston skill` marks it "(team override)".
- **Add a new skill**: create `skills/<name>/SKILL.md` with front matter (`name`, `description`) and the steps. `houston skill <name>` finds it.

Agents get a skill's instructions from `houston skill <name>`, which prints the version that wins, so nothing else needs changing. Check with:

```sh
.houston/bin/houston skill                  # every skill, and whether yours or core's wins
.houston/bin/houston skill intake           # the intake instructions an agent follows
.houston/bin/houston skill intake --path    # just the file they come from
```

To make Claude Code offer a new skill by name, also add a stub in `.claude/skills/<name>/SKILL.md` like the existing ones.

A team version of `run` is used by every teammate's unattended runs, so it's covered by `houston trust` like `.houston/`: after it changes, each person's runs stop until they review it (`git log -p -- skills/run`) and run `houston trust`. Review changes to `skills/` as carefully as code (see `.github/CODEOWNERS.example`).

When `houston update` brings a newer core skill, compare it with your copy and merge what you want; your copy isn't changed.
