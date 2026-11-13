import type { Command } from "../command";
import { HoustonError } from "../lib/util";

export default {
  summary: "(not built yet)",
  usage: "houston page",
  run() {
    throw new HoustonError("houston page is not built yet.");
  },
} satisfies Command;
