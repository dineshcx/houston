import type { Command } from "../command";
import { HoustonError } from "../lib/util";

export default {
  summary: "(not built yet)",
  usage: "houston apply",
  run() {
    throw new HoustonError("houston apply is not built yet.");
  },
} satisfies Command;
