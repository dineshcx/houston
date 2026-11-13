import type { Command } from "../command";
import { HoustonError } from "../lib/util";

export default {
  summary: "(not built yet)",
  usage: "houston schedule",
  run() {
    throw new HoustonError("houston schedule is not built yet.");
  },
} satisfies Command;
