import type { Command } from "../command";
import { HoustonError } from "../lib/util";

export default {
  summary: "(not built yet)",
  usage: "houston link",
  run() {
    throw new HoustonError("houston link is not built yet.");
  },
} satisfies Command;
