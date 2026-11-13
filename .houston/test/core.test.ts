// The shared core: config validation, cadence time maths, the issue rules and the run footer.
import { describe, expect, test } from "bun:test";
import { atZoned, nextOccurrence, parseCadence, parseSchedule, periodOf, nextPeriod, zoned } from "../src/lib/cadence";
import { validateTeam, DEFAULT_RULES, type Team } from "../src/lib/config";
import { planLabels, readSummary, replaceSummary } from "../src/lib/issues";
import { footer, parseFooter, stripFooter } from "../src/lib/pages";

const minimal = {
  houston: 1,
  core: "0.1.0",
  team: { name: "T", leads: ["ana"], members: ["ana", "raj"] },
  projects: { web: { name: "Web", repos: ["acme/web", { repo: "acme/api", about: "API" }], cadences: ["daily"] } },
};

describe("houston.yml", () => {
  test("a minimal file is valid and gets defaults", () => {
    const { team, errors } = validateTeam(minimal, ["daily"]);
    expect(errors).toEqual([]);
    expect(team!.rules).toEqual(DEFAULT_RULES);
    expect(team!.projects.web.repos).toEqual([{ repo: "acme/web" }, { repo: "acme/api", about: "API" }]);
  });

  test("every problem is reported in plain words, unknown keys included", () => {
    const { errors } = validateTeam({ ...minimal, colour: "red", rules: { create_issue: "sometimes" }, projects: { web: { name: "Web", repos: ["not a repo"], cadences: ["weekly"] } } }, ["daily"]);
    expect(errors.join("\n")).toContain("colour: unknown key");
    expect(errors.join("\n")).toContain('rules.create_issue: "sometimes" is not allowed');
    expect(errors.join("\n")).toContain("should be owner/name");
    expect(errors.join("\n")).toContain("there is no cadences/weekly.md");
  });

  test("a repo can't be in two projects", () => {
    const { errors } = validateTeam({ ...minimal, projects: { a: { name: "A", repos: ["x/y"] }, b: { name: "B", repos: ["x/y"] } } });
    expect(errors.join()).toContain("already in project a");
  });
});

describe("cadences", () => {
  test("schedules", () => {
    expect(parseSchedule("Mon-Fri 10:00")).toEqual({ days: [1, 2, 3, 4, 5], time: "10:00" });
    expect(parseSchedule("Fri-Mon 9:05").days).toEqual([0, 1, 5, 6]);
    expect(parseSchedule("daily 07:30").days.length).toBe(7);
    expect(() => parseSchedule("sometimes")).toThrow();
  });

  test("wall-clock times in a timezone, across DST", () => {
    expect(atZoned("2026-11-13", "10:00", "Asia/Kolkata").toISOString()).toBe("2026-11-13T04:30:00.000Z");
    expect(atZoned("2026-07-01", "10:00", "Europe/London").toISOString()).toBe("2026-07-01T09:00:00.000Z");
    expect(atZoned("2026-12-01", "10:00", "Europe/London").toISOString()).toBe("2026-12-01T10:00:00.000Z");
    expect(zoned(new Date("2026-11-13T20:00:00Z"), "Asia/Kolkata").date).toBe("2026-11-14");
  });

  test("next occurrence skips weekends", () => {
    const fri11 = new Date("2026-11-13T05:30:00Z"); // Fri 11:00 in Kolkata
    expect(nextOccurrence(parseSchedule("Mon-Fri 10:00"), fri11, "Asia/Kolkata")!.toISOString()).toBe("2026-11-16T04:30:00.000Z");
  });

  test("periods are named by their first day", () => {
    const c = parseCadence("sprint", "---\nschedule: Mon 10:00\nperiod: sprint\nsprint_start: 2026-11-02\nsprint_length: 2w\n---\nbody");
    expect(periodOf(c, "2026-11-13")).toBe("2026-11-02");
    expect(periodOf(c, "2026-11-16")).toBe("2026-11-16");
    expect(nextPeriod(c, "2026-11-02")).toBe("2026-11-16");
    const w = parseCadence("weekly", "---\nschedule: Mon 10:00\nperiod: week\n---\n");
    expect(periodOf(w, "2026-11-15")).toBe("2026-11-09");
    const m = parseCadence("kpi", "---\nschedule: Mon 10:00\nperiod: month\n---\n");
    expect(nextPeriod(m, "2026-12-01")).toBe("2027-01-01");
  });

  test("strict templates and keys", () => {
    expect(() => parseCadence("x", "---\nschedule: Mon 10:00\npage: \"{{who}}\"\n---\n")).toThrow(/only \{\{title\}\}/);
    expect(() => parseCadence("x", "---\nschedule: Mon 10:00\nwhen: now\n---\n")).toThrow(/unknown key "when"/);
  });
});

describe("issue rules", () => {
  const team = validateTeam(minimal).team as Team;

  test("one status at a time", () => {
    expect(planLabels(team, ["status:todo", "p2", "bug"], ["status:in-progress"], [])).toEqual({ add: ["status:in-progress"], remove: ["status:todo"] });
  });

  test("refuses labels Houston doesn't manage, and rules that forbid it", () => {
    expect(() => planLabels(team, [], ["wontfix"], [])).toThrow(/isn't a label Houston manages/);
    expect(() => planLabels({ ...team, rules: { ...team.rules, status: "never" } }, [], ["status:todo"], [])).toThrow(/rules.status/);
  });

  test("the summary block is replaced in place; everything else is kept", () => {
    const body = "Intro by a person\n\n<!-- houston:summary -->\nold\n<!-- /houston:summary -->\n\nTail";
    const next = replaceSummary(body, "**Goal:** new");
    expect(next).toBe("Intro by a person\n\n<!-- houston:summary -->\n**Goal:** new\n<!-- /houston:summary -->\n\nTail");
    expect(readSummary(next)).toBe("**Goal:** new");
    expect(replaceSummary("Person's text", "S")).toBe("<!-- houston:summary -->\nS\n<!-- /houston:summary -->\n\nPerson's text");
  });
});

describe("the run footer", () => {
  test("reads back what it writes", () => {
    const line = footer(new Date("2026-11-13T03:30:00Z"), "Asia/Kolkata", { github: "ok", sessions: "failed: timeout" }, true);
    expect(line).toBe("_run 09:00 · sources: github ok, sessions failed · not reviewed_");
    expect(parseFooter(line)).toEqual({ time: "09:00", sources: { github: "ok", sessions: "failed" }, notReviewed: true });
    expect(parseFooter("_run 09:00_")).toEqual({ time: "09:00", sources: {}, notReviewed: false });
    expect(parseFooter("_running late_")).toBeUndefined();
    expect(stripFooter(`## Done\n- x\n\n${line}`)).toBe("## Done\n- x");
  });
});
