import type { Command } from "../command";
import { HoustonError } from "../lib/util";

export default {
  summary: "(not built yet)",
  usage: "houston explain",
  run() {
    throw new HoustonError("houston explain is not built yet.");
  },
} satisfies Command;
