import type { Command } from "../command";
import { HoustonError } from "../lib/util";

export default {
  summary: "(not built yet)",
  usage: "houston doctor",
  run() {
    throw new HoustonError("houston doctor is not built yet.");
  },
} satisfies Command;
