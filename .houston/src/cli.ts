// houston: agents decide what to say; this CLI does every write and every check.
import type { Command } from "./command";
import { HoustonError, UsageError } from "./lib/util";

/** Commands in the order `houston help` lists them, grouped by when people use them. */
const COMMANDS: Record<string, () => Promise<{ default: Command }>> = {
  // setting up
  link: () => import("./commands/link"),
  doctor: () => import("./commands/doctor"),
  schedule: () => import("./commands/schedule"),
  validate: () => import("./commands/validate"),
  explain: () => import("./commands/explain"),
  // the run
  run: () => import("./commands/run"),
  collect: () => import("./commands/collect"),
  draft: () => import("./commands/draft"),
  publish: () => import("./commands/publish"),
  // issues and pages
  issues: () => import("./commands/issues"),
  summary: () => import("./commands/summary"),
  labels: () => import("./commands/labels"),
  page: () => import("./commands/page"),
  // intake
  propose: () => import("./commands/propose"),
  apply: () => import("./commands/apply"),
  // the app and core
  app: () => import("./commands/app"),
  skill: () => import("./commands/skill"),
  trust: () => import("./commands/trust"),
  update: () => import("./commands/update"),
};

async function help(name?: string) {
  if (name && COMMANDS[name]) {
    const c = (await COMMANDS[name]()).default;
    console.log(`houston ${name}: ${c.summary}\n\n${c.usage.trim()}`);
    return;
  }
  console.log("houston: your team's context, kept where the work happens.\n\nCommands:");
  for (const [n, load] of Object.entries(COMMANDS)) console.log(`  ${n.padEnd(10)} ${(await load()).default.summary}`);
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
  if (e instanceof HoustonError) {
    console.error(`houston: ${e.message}`);
    if (e instanceof UsageError) console.error(`Run \`houston help ${process.argv[2]}\` to see how to use it.`);
    process.exit(1);
  }
  throw e;
});
