import type { Command } from "../command";
import { HoustonError } from "../lib/util";

export default {
  summary: "(not built yet)",
  usage: "houston update",
  run() {
    throw new HoustonError("houston update is not built yet.");
  },
} satisfies Command;
