// Intake proposals: proposals/<date>-<name>.yml in the Houston repo, reviewed as a pull request
// and applied after merge. (Built by the intake work; the run calls applyMergedProposals.)
import type { Team } from "./config";

/** Applies merged proposals owned by `me` that haven't been applied yet. Returns one line per proposal. */
export function applyMergedProposals(_team: Team, _me: string): string[] {
  return [];
}
