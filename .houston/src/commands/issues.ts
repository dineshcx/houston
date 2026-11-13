import type { Command } from "../command";
import { HoustonError } from "../lib/util";

export default {
  summary: "(not built yet)",
  usage: "houston issues",
  run() {
    throw new HoustonError("houston issues is not built yet.");
  },
} satisfies Command;
