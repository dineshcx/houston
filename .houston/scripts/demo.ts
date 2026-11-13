// bun run demo [--port 4400] [--no-start]: builds a realistic Houston repo in a temp folder (a web
// team with two projects, five members, today's pages, frozen past ones, ~40 issues, a pending
// draft and an intake pull request), then starts the app on it. For developing and screenshotting
// the app. It never touches your real home or repos: HOME is a temp folder, GitHub is a JSON file
// (HOUSTON_FAKE_GITHUB) and the "GitHub" remote is a local bare repo.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { addDays, zoned } from "../src/lib/cadence";
import { renderDraft } from "../src/lib/draft";
import { hash } from "../src/lib/state";

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { port: { type: "string", default: "4400" }, "no-start": { type: "boolean" } } });

const tmp = mkdtempSync(join(tmpdir(), "houston-demo-"));
const root = join(tmp, "repo");
const origin = join(tmp, "github.com/acme/houston.git"); // houstonRepo() reads acme/houston from the path
const fake = join(tmp, "github.json");
const home = join(tmp, "home");
mkdirSync(home);

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const now = new Date();
const today = zoned(now, tz).date;
const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
const weekend = weekday === 0 || weekday === 6;
const monday = addDays(today, -((weekday + 6) % 7));
const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
const hhmm = (d: Date) => zoned(d, tz).time;
/** Earlier weekdays (or days, at the weekend), newest first. */
const pastDays = (n: number) => {
  const out: string[] = [];
  for (let d = addDays(today, -1); out.length < n; d = addDays(d, -1)) {
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (weekend || (wd !== 0 && wd !== 6)) out.push(d);
  }
  return out;
};

// The standup is ~55 minutes away, so drafts publish (15 minutes before it) in ~40 minutes.
const soon = new Date(now.getTime() + 55 * 60_000);
const standupAt = zoned(soon, tz).date === today ? hhmm(soon) : "23:59";

const write = (rel: string, text: string) => {
  const file = join(root, rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
};
const run = (cmd: string[], cwd = root) => {
  const r = Bun.spawnSync(cmd, { cwd, env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
const git = (...args: string[]) => run(["git", "-c", "commit.gpgsign=false", ...args]);

// ---------- the team ----------

write(
  "houston.yml",
  `houston: 1
core: 0.1.0
team:
  name: Web team
  leads: [ana]
  members: [ana, raj, mei, tom, sara]
projects:
  storefront:
    name: Storefront
    repos:
      - { repo: acme/web, about: "The customer-facing store (Next.js)" }
      - { repo: acme/api, about: "Orders, payments and inventory API" }
    cadences: [daily, weekly]
  mobile:
    name: Mobile
    repos:
      - { repo: acme/app, about: "iOS and Android app (React Native)" }
    cadences: [daily, weekly]
status:
  columns:
    - { label: todo, name: Todo }
    - { label: in-progress, name: In progress }
    - { label: in-review, name: In review }
    - { label: blocked, name: Blocked }
`,
);
write("houston.local.yml", `user: ana\ntimezone: ${tz}\nrepos:\n  acme/web: null\n  acme/api: null\n  acme/app: null\nschedule: launchd runs houston run every 3h on weekdays\n`);
write(
  "cadences/daily.md",
  `---
title: Daily standup
schedule: "${weekend ? "daily" : "Mon-Fri"} ${standupAt}"
period: day
writers: [runs, people]
page: |
  # {{title}}, {{period}}

  ## Agenda

  ## Notes

  ## Decisions

  ## Action items
---
## Done
- owner/repo#123 What finished since the last standup

## Doing
- owner/repo#123 What is moving now and the next step

## Blocked
- owner/repo#123 What it's waiting on, and who (@username)

## Other
- Real work that matches no issue
`,
);
write(
  "cadences/weekly.md",
  `---
title: Weekly sync
schedule: "Mon 10:00"
period: week
writers: [runs, people]
page: |
  # {{title}}, week of {{period}}

  ## Agenda

  ## Notes

  ## Decisions

  ## Action items
---
## Done
- owner/repo#123 What finished this week

## Doing
- owner/repo#123 What carries on next week

## Blocked
- owner/repo#123 What it's waiting on, and who

## Other
- Real work that matches no issue
`,
);
write(".gitignore", ".houston-local/\nhouston.local.yml\n");

// ---------- issues ----------

const summary = (goal: string, state: string, next: string, decisions = "", questions = "") =>
  `<!-- houston:summary -->\n**Goal:** ${goal}\n\n**State:** ${state}\n\n**Next step:** ${next}\n\n**Decisions:**\n${decisions || "- none yet"}\n\n**Open questions:**\n${questions || "- none"}\n<!-- /houston:summary -->\n\n`;
type Spec = [repo: string, n: number, title: string, status: string | null, who: string[], extra?: string[], body?: string, closed?: boolean];
const SPECS: Spec[] = [
  ["acme/web", 3, "Remove the old cart drawer", null, ["raj"], ["p3"], "", true],
  ["acme/web", 12, "Checkout: retry failed card payments once", "in-progress", ["ana"], ["p1", "kind:feature"], summary("Fewer abandoned checkouts when a card payment fails transiently.", "Retry logic merged behind the `checkout_retry` flag; testing on staging.", "Turn the flag on for 10% of traffic on Monday.", "- Retry once, never twice (double charges)", "- Do we show a message while retrying?")],
  ["acme/web", 14, "Product page images flicker on Safari", "todo", ["raj"], ["p2", "kind:bug"]],
  ["acme/web", 15, "Search: show recent searches", "todo", ["mei"], ["p3", "kind:feature"]],
  ["acme/web", 17, "Promo banner overlaps the header on small screens", "in-review", ["mei"], ["p2", "kind:bug"]],
  ["acme/web", 18, "Move analytics to the new events schema", "blocked", ["tom"], ["p1", "kind:task"], summary("All storefront events use schema v2 so the data team can drop v1.", "Waiting on the data team to publish the v2 consent fields.", "Tom pairs with data on Tuesday.", "", "- Who owns the consent banner events?")],
  ["acme/web", 20, "Wishlist: share a list by link", null, [], ["kind:feature"]],
  ["acme/web", 21, "Footer links audit", null, [], []],
  ["acme/web", 22, "Lighthouse score below 80 on category pages", "todo", ["tom"], ["p2", "kind:investigation"]],
  ["acme/web", 23, "Gift cards in checkout", "backlog", [], ["kind:feature"]],
  ["acme/web", 24, "Address autocomplete misses flat numbers", "in-progress", ["sara"], ["p2", "kind:bug"]],
  ["acme/web", 25, "Dark mode for account pages", null, [], ["kind:feature"]],
  ["acme/web", 26, "Cookie banner text from legal", "todo", [], ["p3", "kind:task"]],
  ["acme/web", 27, "Order history pagination", "in-review", ["raj"], ["p2", "kind:feature"], summary("Customers with many orders can page through history quickly.", "PR #41 up; review requested from Ana.", "Merge after review.")],
  ["acme/web", 28, "Upgrade to Next 16", null, [], ["kind:task"]],
  ["acme/web", 29, "Basket badge shows stale count after login", "todo", ["mei"], ["p1", "kind:bug"]],
  ["acme/api", 4, "Rate-limit the order lookup endpoint", "in-progress", ["tom"], ["p1", "kind:task"]],
  ["acme/api", 7, "Payments: idempotency keys for card retries", "in-review", ["ana"], ["p0", "kind:feature"], summary("Retrying a card payment can never charge twice.", "Idempotency keys on every payment call; PR in review.", "Raj reviews; ship with the checkout retry flag.", "- Keys expire after 24h")],
  ["acme/api", 8, "Inventory sync drops items with emoji in the SKU", "blocked", ["raj"], ["p1", "kind:bug"], summary("Inventory sync handles every SKU the warehouse sends.", "Root cause found in the warehouse CSV encoding.", "Waiting on the warehouse team to re-export as UTF-8.")],
  ["acme/api", 9, "Order webhooks: add delivery events", "todo", ["sara"], ["p2", "kind:feature"]],
  ["acme/api", 10, "Slow query on /orders?status=", "todo", [], ["p2", "kind:investigation"]],
  ["acme/api", 11, "Remove the v1 auth tokens", null, [], ["kind:task"]],
  ["acme/api", 12, "OpenAPI spec out of date", null, [], []],
  ["acme/api", 13, "Refund endpoint returns 500 on partial refunds", "in-progress", ["sara"], ["p1", "kind:bug"]],
  ["acme/api", 14, "Tax rates for the new regions", "backlog", [], ["kind:task"]],
  ["acme/api", 15, "Health check should include the queue", "todo", ["tom"], ["p3", "kind:task"]],
  ["acme/api", 16, "Postgres 17 upgrade plan", null, [], ["kind:investigation"]],
  ["acme/app", 2, "Push notifications for order status", "in-progress", ["mei"], ["p1", "kind:feature"], summary("Customers hear about shipping without opening the app.", "iOS done; Android token refresh flaky.", "Fix Android token refresh, then beta.", "", "- Quiet hours by default?")],
  ["acme/app", 3, "Release 4.2 to the stores", "todo", ["ana"], ["p1", "kind:task"]],
  ["acme/app", 5, "Crash on launch on Android 9", "blocked", ["sara"], ["p0", "kind:bug"], summary("No crashes on launch on any supported Android version.", "Only Android 9 Samsung devices; we can't reproduce on emulators.", "Waiting for a test device from QA.")],
  ["acme/app", 6, "Biometric login", "in-review", ["mei"], ["p2", "kind:feature"]],
  ["acme/app", 7, "Offline basket", null, [], ["kind:feature"]],
  ["acme/app", 8, "Deep links from emails open the home screen", "todo", ["raj"], ["p2", "kind:bug"]],
  ["acme/app", 9, "Accessibility audit (VoiceOver)", "todo", ["sara"], ["p2", "kind:task"]],
  ["acme/app", 10, "App size over 80 MB", null, [], ["kind:investigation"]],
  ["acme/app", 11, "Dark mode icons", "backlog", [], []],
  ["acme/app", 12, "Order tracking map", null, [], ["kind:feature"]],
  ["acme/app", 13, "Sentry release tagging", "in-progress", ["tom"], ["p3", "kind:task"]],
  ["acme/app", 14, "Upgrade React Native to 0.80", null, [], ["kind:task"]],
  ["acme/app", 15, "Login screen copy from marketing", "todo", [], ["p3"]],
];
const COMMENTS: Record<string, string[]> = {
  "acme/web#12": ["Staging looks good with the flag on. Retries show up in the payment logs as expected.", "Let's wait for acme/api#7 before any production traffic."],
  "acme/web#18": ["Pinged the data team again; they expect the consent fields next week."],
};
const issues = SPECS.map(([repo, number, title, status, assignees, extra = [], body = "", closed = false], i) => ({
  repo,
  number,
  title,
  state: closed ? "closed" : "open",
  body: `${body}${title}.\n\nRaised in standup.`,
  labels: [...(status ? [`status:${status}`] : []), ...extra],
  assignees,
  url: `https://github.com/${repo}/issues/${number}`,
  updatedAt: ago(30 + i * 97),
  ...(COMMENTS[`${repo}#${number}`] ? { comments: COMMENTS[`${repo}#${number}`] } : {}),
}));

// ---------- pages ----------

const foot = (time: string, sources: Record<string, string>, notReviewed = false) =>
  `_run ${time} · sources: ${Object.entries(sources).map(([k, v]) => `${k} ${v === "ok" ? "ok" : "failed"}`).join(", ")}${notReviewed ? " · not reviewed" : ""}_`;
const OK = { github: "ok", git: "ok", sessions: "ok" };
const update = (done: string[], doing: string[], blocked: string[], other: string[], footer: string) =>
  `## Done\n${(done.length ? done : ["nothing"]).map((l) => `- ${l}`).join("\n")}\n\n## Doing\n${doing.map((l) => `- ${l}`).join("\n")}\n\n## Blocked\n${(blocked.length ? blocked : ["nothing"]).map((l) => `- ${l}`).join("\n")}\n\n## Other\n${(other.length ? other : ["nothing"]).map((l) => `- ${l}`).join("\n")}\n\n${footer}\n`;
const earlier = hhmm(new Date(now.getTime() - 50 * 60_000));
const morning = hhmm(new Date(now.getTime() - 110 * 60_000));

const day = (p: string, period: string) => `projects/${p}/daily/${period}`;
// Today, Storefront: raj clean, mei "not reviewed" with GitHub failed, tom blocked, ana's is in her draft, sara never ran.
write(
  `${day("storefront", today)}/_page.md`,
  `# Daily standup, ${today}

## Agenda

- Checkout retry rollout (acme/web#12, acme/api#7)
- Analytics schema v2 is still blocked: acme/web#18
- Bug triage: acme/web#29, acme/web#14

## Notes

Ana: retry flag works on staging; the idempotency keys in acme/api#7 need one more review.

Tom is waiting on the data team for the consent fields. **Escalate** if nothing by Tuesday.

## Decisions

- Roll out checkout retries to 10% on Monday, behind the flag.
- The old cart drawer (acme/web#3) is gone; no need to keep its styles.

## Action items

- [ ] @raj review the idempotency PR for acme/api#7 today
- [ ] @tom pair with data on acme/web#18 on Tuesday
- [x] @mei reproduce the basket badge bug acme/web#29
`,
);
write(`${day("storefront", today)}/raj.md`, update(["acme/web#27 Order history pagination: PR up for review", "acme/web#3 Removed the old cart drawer"], ["acme/web#14 Looking into the Safari image flicker; suspect lazy-load placeholder", "acme/api#8 Waiting on the warehouse re-export"], [], ["Helped Sara debug the address autocomplete fixture"], foot(earlier, OK)));
write(`${day("storefront", today)}/mei.md`, update(["acme/web#17 Promo banner fix ready for review"], ["acme/web#29 Reproduced the stale basket badge; fix next"], [], [], foot(morning, { github: "failed: HTTP 502", git: "ok", sessions: "ok" }, true)));
write(`${day("storefront", today)}/tom.md`, update(["acme/api#4 Rate limiter for order lookup deployed to staging"], ["acme/api#15 Queue health check"], ["acme/web#18 Waiting on the data team's consent fields (@ana to escalate)", "Staging database is read-only since this morning; asked infra in #ops"], [], foot(earlier, OK)));

// Today, Mobile: mei and raj in, tom ran today with nothing for this page, ana in her draft, sara never ran.
write(
  `${day("mobile", today)}/_page.md`,
  `# Daily standup, ${today}

## Agenda

- Release 4.2 (acme/app#3)
- Android 9 crash: acme/app#5

## Notes

## Decisions

## Action items

- [ ] @sara get an Android 9 device from QA for acme/app#5
`,
);
write(`${day("mobile", today)}/mei.md`, update(["acme/app#6 Biometric login PR ready"], ["acme/app#2 Fixing Android token refresh for push"], [], [], foot(morning, OK)));
write(`${day("mobile", today)}/raj.md`, update([], ["acme/app#8 Deep links: tracing the email link handler"], [], [], foot(earlier, OK)));

// Past periods: frozen, with notes and most updates.
for (const [i, period] of pastDays(4).entries()) {
  write(`${day("storefront", period)}/_page.md`, `# Daily standup, ${period}\n\n## Agenda\n\n- Checkout retries (acme/web#12)\n\n## Notes\n\nShort one today${i === 0 ? "; Raj out in the afternoon" : ""}.\n\n## Decisions\n\n- Keep the retry flag off in production until the keys land.\n\n## Action items\n\n- [x] @ana write up the retry plan\n`);
  write(`${day("storefront", period)}/raj.md`, update(["acme/web#3 Cart drawer cleanup"], ["acme/web#27 Pagination"], [], [], foot("08:40", OK)));
  write(`${day("storefront", period)}/ana.md`, update(["acme/api#7 Idempotency keys: first pass"], ["acme/web#12 Retry flag"], [], [], foot("08:35", OK, i === 1)));
  if (i < 3) write(`${day("storefront", period)}/tom.md`, update(["acme/api#4 Rate limiter design"], ["acme/web#18 Analytics v2"], i === 0 ? ["acme/web#18 Waiting on data for the consent fields"] : [], [], foot("08:50", OK)));
  write(`${day("storefront", period)}/mei.md`, update(["acme/web#17 Banner overlap: found the cause"], ["acme/web#15 Recent searches"], [], [], foot("08:30", OK)));
  if (i < 2) {
    write(`${day("mobile", period)}/_page.md`, `# Daily standup, ${period}\n\n## Agenda\n\n## Notes\n\nRelease 4.2 slips a day for acme/app#5.\n\n## Decisions\n\n## Action items\n`);
    write(`${day("mobile", period)}/mei.md`, update(["acme/app#2 iOS push done"], ["acme/app#2 Android push"], [], [], foot("08:30", OK)));
    write(`${day("mobile", period)}/tom.md`, update(["acme/app#13 Sentry releases tagged on iOS"], ["acme/app#13 Android"], [], [], foot("08:50", OK)));
  }
}

// This week's weekly sync and last week's (frozen).
write(`projects/storefront/weekly/${monday}/_page.md`, `# Weekly sync, week of ${monday}\n\n## Agenda\n\n- Checkout retry rollout plan\n- Analytics v2: what's blocking (acme/web#18)\n\n## Notes\n\n## Decisions\n\n## Action items\n`);
write(`projects/storefront/weekly/${monday}/raj.md`, update(["acme/web#3 Old cart drawer removed"], ["acme/web#27 Order history pagination in review", "acme/api#8 Inventory sync fix waits on the warehouse"], ["acme/api#8 Warehouse re-export as UTF-8 (@ana chasing)"], [], foot("10:00", OK)));
write(`projects/storefront/weekly/${monday}/tom.md`, update(["acme/api#4 Rate limiter on staging"], ["acme/web#18 Analytics v2"], ["acme/web#18 Data team consent fields"], [], foot("09:45", OK)));
write(`projects/mobile/weekly/${monday}/_page.md`, `# Weekly sync, week of ${monday}\n\n## Agenda\n\n- Release 4.2\n\n## Notes\n\n## Decisions\n\n## Action items\n`);
const lastMonday = addDays(monday, -7);
write(`projects/storefront/weekly/${lastMonday}/_page.md`, `# Weekly sync, week of ${lastMonday}\n\n## Agenda\n\n- Q4 checkout goals\n\n## Notes\n\nAgreed the retry design; Ana owns it.\n\n## Decisions\n\n- Retries ship behind a flag (acme/web#12).\n\n## Action items\n\n- [x] @ana open acme/api#7 for idempotency keys\n`);
write(`projects/storefront/weekly/${lastMonday}/ana.md`, update(["acme/web#12 Retry design agreed"], ["acme/api#7 Idempotency keys"], [], [], foot("09:50", OK)));
write(`projects/storefront/weekly/${lastMonday}/raj.md`, update(["acme/web#27 Pagination started"], [], [], [], foot("09:55", OK)));

// Day logs (each person's own record).
const [yesterday, before] = pastDays(2);
for (const [user, dates] of Object.entries({ ana: [yesterday, before], raj: [today, yesterday, before], mei: [today, yesterday], tom: [today, yesterday] }))
  for (const d of dates) write(`people/${user}/${d}.md`, `## ${d}\n\n- Worked on the items in my standup update.\n- Reviewed a teammate's PR.\n\n${foot(d === today ? earlier : "08:40", d === today && user === "mei" ? { github: "failed: HTTP 502", git: "ok", sessions: "ok" } : OK, d === today && user === "mei")}\n`);

// ---------- git: the repo, its "GitHub" remote and an intake PR ----------

run(["git", "init", "-q", "--bare", "-b", "main", origin], tmp);
git("init", "-q", "-b", "main");
git("config", "user.email", "ana@example.com");
git("config", "user.name", "Ana (demo)");
git("add", ".");
git("commit", "-qm", "Houston demo team");
git("remote", "add", "origin", origin);
git("push", "-q", "-u", "origin", "main");
git("remote", "set-head", "origin", "main");

git("switch", "-q", "-c", "houston/intake-design-sync");
write(
  `projects/storefront/meetings/${today}-design-sync.md`,
  `# Design sync, ${today}\n\nWith Ana, Mei, Raj.\n\n## Decisions\n\n- Checkout shows "Trying again…" while a payment retries (acme/web#12).\n- Recent searches ship without personalisation first.\n\n## Questions\n\n- Do we keep the promo banner on mobile web?\n`,
);
write(
  `proposals/${today}-design-sync.yml`,
  `title: Design sync, ${today}
owner: ana
project: storefront
source: projects/storefront/meetings/${today}-design-sync.md
changes:
  - create:
      repo: acme/web
      title: "Checkout: show 'Trying again…' while a payment retries"
      goal: Customers know a retry is happening and don't double-click Pay.
      next_step: Mei designs the inline message.
      assignee: mei
      priority: p2
      kind: feature
      raised_by: ana
  - update:
      issue: acme/web#15
      add_decision: Ship recent searches without personalisation first.
      status: in-progress
  - comment:
      issue: acme/web#17
      body: "From the design sync: keep the promo banner on mobile web for now; revisit after the holiday sale."
skipped:
  - "Caching product images at the edge: nobody owned it yet"
`,
);
git("add", ".");
git("commit", "-qm", "intake: design sync");
git("push", "-q", "origin", "houston/intake-design-sync");
git("switch", "-q", "main");

writeFileSync(
  fake,
  JSON.stringify(
    {
      login: "ana",
      activity: [],
      issues,
      pulls: [{ repo: "acme/houston", number: 4, title: `Design sync, ${today}`, body: "Notes and proposed issue changes from the design sync.", state: "open", url: "https://github.com/acme/houston/pull/4", branch: "houston/intake-design-sync", author: "ana", labels: ["houston:intake"], updatedAt: ago(30) }],
      labels: {},
      subIssues: [],
      writes: [],
    },
    null,
    2,
  ),
);

// ---------- ana's pending draft and run state ----------

const windowStart = new Date(now.getTime() - 180 * 60_000);
const windowEnd = new Date(now.getTime() - 20 * 60_000);
const draft = renderDraft(
  [
    { kind: "page", target: `storefront/daily/${today}`, body: update(["acme/api#7 Idempotency keys: addressed review comments"], ["acme/web#12 Retry flag: 10% rollout plan for Monday", "acme/app#3 Release 4.2 checklist"], [], ["Interviewed a support lead about failed payments"], "").trim() },
    { kind: "day", target: today, body: "- Addressed review comments on the idempotency PR (acme/api#7)\n- Wrote the 10% rollout plan for checkout retries\n- Went through the 4.2 release checklist\n- 30 min with support about failed payments\n- Reviewed Raj's pagination PR (acme/web#27)\n- Triage: acme/web#29, acme/web#14" },
    { kind: "summary", target: "acme/web#12", body: "**Goal:** Fewer abandoned checkouts when a card payment fails transiently.\n\n**State:** Retry logic merged behind `checkout_retry`; idempotency keys (acme/api#7) in review.\n\n**Next step:** 10% rollout on Monday once acme/api#7 merges.\n\n**Decisions:**\n- Retry once, never twice (double charges)\n- Show \"Trying again…\" during the retry\n\n**Open questions:**\n- none" },
    { kind: "summary", target: "acme/api#7", body: "**Goal:** Retrying a card payment can never charge twice.\n\n**State:** Review comments addressed; waiting for Raj's approval.\n\n**Next step:** Merge, then ship with the checkout retry flag.\n\n**Decisions:**\n- Keys expire after 24h" },
    { kind: "labels", target: "acme/web#12", body: "status:in-review" },
  ],
  `<!-- houston draft · window ${hhmm(windowStart)} → ${hhmm(windowEnd)} · publishes in about 40 minutes unless you approve or hold it -->`,
);
write(".houston-local/draft.md", draft);
write(
  ".houston-local/state.json",
  JSON.stringify(
    {
      last_publish: new Date(now.getTime() - 26 * 3_600_000).toISOString(),
      last_run: { at: ago(10), outcome: "failed", note: "gh: HTTP 502 from api.github.com" },
      draft: {
        created: windowEnd.toISOString(),
        window_start: windowStart.toISOString(),
        window_end: windowEnd.toISOString(),
        deadline: new Date(now.getTime() + 40 * 60_000).toISOString(),
        agent_hash: hash(draft),
        sources: OK,
        inbox: [],
      },
    },
    null,
    2,
  ),
);

const env = { ...process.env, HOUSTON_ROOT: root, HOUSTON_FAKE_GITHUB: fake, HOME: home, HOUSTON_NO_NOTIFY: "1" };
console.log(`Demo Houston repo: ${root}\nFake GitHub: ${fake}\nTemp home: ${home}`);
if (values["no-start"]) {
  console.log(`\nStart the app on it with:\n  HOUSTON_ROOT=${root} HOUSTON_FAKE_GITHUB=${fake} HOME=${home} HOUSTON_NO_NOTIFY=1 bun ${join(import.meta.dir, "../src/cli.ts")} app --no-open --port ${values.port}`);
} else {
  const app = Bun.spawn(["bun", "--no-env-file", `--config=${join(import.meta.dir, "../bunfig.toml")}`, join(import.meta.dir, "../src/cli.ts"), "app", "--no-open", "--port", values.port!], { cwd: root, env, stdout: "inherit", stderr: "inherit" });
  process.on("SIGINT", () => app.kill("SIGINT"));
  process.exit(await app.exited);
}
