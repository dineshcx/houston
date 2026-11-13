import type { Command } from "../command";
import { HoustonError } from "../lib/util";

export default {
  summary: "(not built yet)",
  usage: "houston run",
  run() {
    throw new HoustonError("houston run is not built yet.");
  },
} satisfies Command;
