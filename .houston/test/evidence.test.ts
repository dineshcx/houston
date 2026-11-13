// Evidence: the fixed matching order, exact-path session reading, inbox consumption, and failed sources.
import { beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateTeam, type Local, type Team } from "../src/lib/config";
import { collect, consumeInbox, isQuiet, renderDigest, sessionDirName, type Digest } from "../src/lib/evidence";

const tmp = mkdtempSync(join(tmpdir(), "houston-evidence-"));
const web = join(tmp, "web");
const fake = join(tmp, "github.json");
const team = validateTeam({
  houston: 1,
  core: "0.1.0",
  team: { name: "T", leads: ["ana"], members: ["ana"] },
  projects: { store: { name: "Store", repos: ["acme/web", "acme/api"], cadences: [] } },
}).team as Team;
const local: Local = { user: "ana", timezone: "UTC", repos: { "acme/web": web, "acme/api": null } };
const since = new Date(Date.now() - 3_600_000);
const now = () => new Date().toISOString();

function git(...args: string[]) {
  const p = Bun.spawnSync(["git", "-C", web, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
}

function session(dir: string, lines: object[]) {
  mkdirSync(join(tmp, "home/.claude/projects", dir), { recursive: true });
  writeFileSync(join(tmp, "home/.claude/projects", dir, "s1.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n"));
}

const issue = (number: number, title: string) => ({ repo: "acme/web", number, title, state: "open", body: "", labels: [], assignees: ["ana"], url: "", updatedAt: now() });

let digest: Digest;

beforeAll(() => {
  process.env.HOME = join(tmp, "home");
  process.env.HOUSTON_FAKE_GITHUB = fake;
  writeFileSync(
    fake,
    JSON.stringify({
      login: "ana",
      issues: [issue(5, "Dark mode toggle"), issue(12, "Checkout retries")],
      activity: [{ at: now(), repo: "acme/web", kind: "merged PR", number: 40, branch: "15-retry", text: "Retry with backoff\nFixes #12" }],
    }),
  );
  mkdirSync(web);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "ana@example.com");
  git("config", "user.name", "Ana");
  git("commit", "-q", "--allow-empty", "-m", "tidy imports");
  git("commit", "-q", "--allow-empty", "-m", "Retry checkout #12");
  git("checkout", "-q", "-b", "7-login");
  git("commit", "-q", "--allow-empty", "-m", "wip");
  writeFileSync(join(web, ".houston-inbox.md"), "- 10:00 reviewed the spec for acme/web#9\n");
  writeFileSync(join(web, ".git/info/exclude"), ".houston-inbox.md\n");
  const user = (content: unknown) => ({ type: "user", timestamp: now(), gitBranch: "main", message: { role: "user", content } });
  session(sessionDirName(web), [
    user("<command-name>/clear</command-name>"),
    user("Make the Dark mode toggle persist across reloads"),
    { type: "assistant", timestamp: now(), message: { content: [{ type: "text", text: "Saved it in localStorage." }] } },
  ]);
  // A sibling folder whose name starts with the repo's: must never be read as the repo's sessions.
  session(sessionDirName(web + "-admin"), [user("secret admin work on Checkout retries")]);
  digest = collect(team, local, since);
});

describe("collect", () => {
  test("matches in the fixed order and keeps the rest under Other", () => {
    const by = (text: string) => digest.items.find((e) => e.text.includes(text))!;
    expect(by("Fixes #12")).toMatchObject({ ref: "acme/web#12", why: "the PR references it" }); // beats its branch 15-retry
    expect(by("Retry checkout")).toMatchObject({ ref: "acme/web#12", why: "the commit message names it" });
    expect(by("wip")).toMatchObject({ ref: "acme/web#7", why: "branch 7-login" });
    expect(by("reviewed the spec")).toMatchObject({ ref: "acme/web#9", why: "the inbox line names it" });
    expect(by("asked: Make the Dark mode")).toMatchObject({ ref: "acme/web#5", why: "it names the issue's title" });
    expect(by("tidy imports").ref).toBeUndefined();
    const text = renderDigest(digest, team);
    expect(text).toContain("## acme/web#12 Checkout retries");
    expect(text.split("## Other")[1]).toContain("tidy imports");
    expect(text).toContain('<untrusted source="git acme/web">tidy imports</untrusted>');
  });

  test("reads sessions only from the repo's exact folder, without injected text", () => {
    const all = digest.items.filter((e) => e.source === "sessions").map((e) => e.text).join("\n");
    expect(all).toContain("last answer: Saved it in localStorage.");
    expect(all).not.toContain("secret admin");
    expect(all).not.toContain("command-name");
  });

  test("lists repos not on this machine and isn't quiet", () => {
    expect(digest.skipped).toEqual(["acme/api"]);
    expect(digest.assigned.map((i) => i.ref)).toEqual(["acme/web#5", "acme/web#12"]);
    expect(isQuiet(digest)).toBe(false);
  });

  test("consuming the inbox removes only the lines the digest read", () => {
    const file = join(web, ".houston-inbox.md");
    appendFileSync(file, "- 11:00 added later\n");
    consumeInbox(digest.inbox);
    expect(readFileSync(file, "utf8")).toBe("- 11:00 added later\n");
  });

  test("a failed source is recorded and the others still run", () => {
    writeFileSync(fake, "{ not json");
    const d = collect(team, local, since);
    expect(d.sources.github).toStartWith("failed: ");
    expect(d.sources.git).toBe("ok");
    expect(d.items.some((e) => e.text === "wip")).toBe(true);
    expect(isQuiet(d)).toBe(false); // a failed source never reads as a quiet day
  });
});
