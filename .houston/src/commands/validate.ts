import type { Command } from "../command";
import { HoustonError } from "../lib/util";

export default {
  summary: "(not built yet)",
  usage: "houston validate",
  run() {
    throw new HoustonError("houston validate is not built yet.");
  },
} satisfies Command;
