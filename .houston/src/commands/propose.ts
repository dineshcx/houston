import type { Command } from "../command";
import { HoustonError } from "../lib/util";

export default {
  summary: "(not built yet)",
  usage: "houston propose",
  run() {
    throw new HoustonError("houston propose is not built yet.");
  },
} satisfies Command;
