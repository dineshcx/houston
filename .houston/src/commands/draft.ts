import type { Command } from "../command";
import { HoustonError } from "../lib/util";

export default {
  summary: "(not built yet)",
  usage: "houston draft",
  run() {
    throw new HoustonError("houston draft is not built yet.");
  },
} satisfies Command;
