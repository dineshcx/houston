import type { Command } from "../command";
import { HoustonError } from "../lib/util";

export default {
  summary: "(not built yet)",
  usage: "houston publish",
  run() {
    throw new HoustonError("houston publish is not built yet.");
  },
} satisfies Command;
