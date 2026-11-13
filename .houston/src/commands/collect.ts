import type { Command } from "../command";
import { HoustonError } from "../lib/util";

export default {
  summary: "(not built yet)",
  usage: "houston collect",
  run() {
    throw new HoustonError("houston collect is not built yet.");
  },
} satisfies Command;
