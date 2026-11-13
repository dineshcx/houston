import type { Command } from "../command";
import { HoustonError } from "../lib/util";

export default {
  summary: "(not built yet)",
  usage: "houston summary",
  run() {
    throw new HoustonError("houston summary is not built yet.");
  },
} satisfies Command;
