// houston: agents decide what to say; this CLI does every write and every check.
import type { Command } from "./command";
import { HoustonError, UsageError } from "./lib/util";

type Load = () => Promise<{ default: Command }>;

/** Commands as `houston help` lists them, grouped by when people use them. */
const GROUPS: [string, Record<string, Load>][] = [
  [
    "Every day",
    {
      run: () => import("./commands/run"),
      draft: () => import("./commands/draft"),
      publish: () => import("./commands/publish"),
      app: () => import("./commands/app"),
    },
  ],
  [
    "Setting up",
    {
      link: () => import("./commands/link"),
      doctor: () => import("./commands/doctor"),
      schedule: () => import("./commands/schedule"),
      trust: () => import("./commands/trust"),
      update: () => import("./commands/update"),
    },
  ],
  [
    "Your team's setup",
    {
      validate: () => import("./commands/validate"),
      explain: () => import("./commands/explain"),
      skill: () => import("./commands/skill"),
    },
  ],
  [
    "Used by agents and skills",
    {
      collect: () => import("./commands/collect"),
      issues: () => import("./commands/issues"),
      summary: () => import("./commands/summary"),
      labels: () => import("./commands/labels"),
      page: () => import("./commands/page"),
      propose: () => import("./commands/propose"),
      apply: () => import("./commands/apply"),
    },
  ],
];
const COMMANDS: Record<string, Load> = Object.assign({}, ...GROUPS.map(([, cmds]) => cmds));

async function help(name?: string) {
  if (name && COMMANDS[name]) {
    const c = (await COMMANDS[name]()).default;
    console.log(`houston ${name}: ${c.summary}\n\n${c.usage.trim()}`);
    return;
  }
  console.log("houston: your team's context, kept where the work happens.");
  for (const [group, cmds] of GROUPS) {
    console.log(`\n${group}:`);
    for (const [n, load] of Object.entries(cmds)) console.log(`  ${n.padEnd(10)} ${(await load()).default.summary}`);
  }
  console.log("\nRun `houston help <command>` for its options.");
}

async function main(argv: string[]) {
  const [name, ...args] = argv;
  if (!name || name === "help" || name === "--help" || name === "-h") return help(args[0]);
  if (!COMMANDS[name]) throw new HoustonError(`Unknown command "${name}". Run \`houston help\` to see them all.`);
  if (args.includes("--help") || args.includes("-h")) return help(name);
  await (await COMMANDS[name]()).default.run(args);
}

main(process.argv.slice(2)).catch((e) => {
  // parseArgs refuses unknown or malformed flags; that's wrong usage too, not a crash.
  if (String(e?.code).startsWith("ERR_PARSE_ARGS")) e = new UsageError(e.message);
  if (e instanceof HoustonError) {
    console.error(`houston: ${e.message}`);
    if (e instanceof UsageError) console.error(`Run \`houston help ${process.argv[2]}\` to see how to use it.`);
    process.exit(1);
  }
  throw e;
});
