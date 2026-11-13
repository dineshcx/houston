# templates

Optional. Every new issue Houston creates (from an intake proposal) starts with a living summary. By default it's `.houston/templates/issue.md`.

To change it for your team, copy that file here as `templates/issue.md` and edit it. Yours wins from then on, and `houston update` never touches it.

- Only the block between `<!-- houston:summary -->` and `<!-- /houston:summary -->` is used.
- Houston fills three placeholders: `{{goal}}`, `{{raised_by}}` and `{{next_step}}`. Any other `{{…}}` is refused.
- Run `.houston/bin/houston validate` after editing; it checks this file too.

There is one template for every kind of issue. Delete `templates/issue.md` to go back to the default.
