import type { Command } from "../command";
import { HoustonError } from "../lib/util";

export default {
  summary: "(not built yet)",
  usage: "houston trust",
  run() {
    throw new HoustonError("houston trust is not built yet.");
  },
} satisfies Command;
