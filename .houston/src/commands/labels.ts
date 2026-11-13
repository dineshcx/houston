import type { Command } from "../command";
import { HoustonError } from "../lib/util";

export default {
  summary: "(not built yet)",
  usage: "houston labels",
  run() {
    throw new HoustonError("houston labels is not built yet.");
  },
} satisfies Command;
