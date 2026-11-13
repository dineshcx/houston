// houston app: starts the local app on 127.0.0.1 and opens it in the browser.
import { parseArgs } from "node:util";
import { createServer } from "../../app/server";
import type { Command } from "../command";
import { HoustonError, sh, UsageError } from "../lib/util";

export default {
  summary: "Start the local app on 127.0.0.1",
  usage: `
houston app [--port 4317] [--no-open]

  --port <n>   Port to listen on (default 4317; 0 picks a free one)
  --no-open    Don't open the browser`,
  run(args) {
    const { values } = parseArgs({ args, options: { port: { type: "string", default: "4317" }, "no-open": { type: "boolean" } }, strict: true, allowPositionals: true });
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError(`"${values.port}" is not a port. Use a number like 4317.`);
    let server;
    try {
      server = createServer({ port });
    } catch (e) {
      throw new HoustonError(`Couldn't listen on port ${port} (${(e as Error).message}). Try \`houston app --port ${port + 1}\`.`);
    }
    const url = `http://127.0.0.1:${server.port}/`;
    console.log(`Houston is running at ${url}  (Ctrl-C to stop)`);
    if (!values["no-open"] && process.platform === "darwin") sh(["open", url]);
  },
} satisfies Command;
