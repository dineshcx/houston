// The shape every command file exports. One file per command in src/commands/.
export type Command = {
  /** One line for `houston help`. */
  summary: string;
  /** Usage and options, shown by `houston help <command>`. */
  usage: string;
  run(args: string[]): Promise<void> | void;
};
