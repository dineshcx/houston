import type { Command } from "../command";
import { HoustonError } from "../lib/util";

export default {
  summary: "(not built yet)",
  usage: "houston skill",
  run() {
    throw new HoustonError("houston skill is not built yet.");
  },
} satisfies Command;
