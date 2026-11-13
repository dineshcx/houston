import type { Command } from "../command";
import { HoustonError } from "../lib/util";

export default {
  summary: "(not built yet)",
  usage: "houston app",
  run() {
    throw new HoustonError("houston app is not built yet.");
  },
} satisfies Command;
