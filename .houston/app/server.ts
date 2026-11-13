// The local app's server: a JSON API plus the static files in public/, on 127.0.0.1 only.
// Reads use the shared core directly; slow GitHub and git work runs on a worker thread (worker.ts)
// and CLI calls run as async subprocesses, so one slow request never freezes the others. Run-loop
// writes (publish, hold/release/discard, labels, new pages) go through the houston CLI, so the run
// lock and the team's rules live in one place. The API itself is in api/; docs in docs/app.md.
import { existsSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { HoustonError } from "../src/lib/util";
import { context, HttpError } from "./api/common";
import { draftAction, editSection, readDraft, removeSection, saveRaw } from "./api/draft";
import { board, issueDetail, lookupIssues, merge, refFrom, review, setStatus } from "./api/github";
import { flushNotes, readPage, startPage, syncNotes, writeNotes } from "./api/pages";
import { about, doctor, people, setup, today } from "./api/team";

const PUBLIC = join(import.meta.dir, "public");

type Handler = (m: string[], body: any, url: URL) => unknown;
const SEG = "([^/]+)";
const routes: [string, RegExp, Handler][] = [
  ["GET", /^\/api\/context$/, () => about(context())],
  ["GET", /^\/api\/today$/, () => today(context())],

  ["GET", new RegExp(`^/api/page/${SEG}/${SEG}(?:/${SEG})?$`), ([p, c, d]) => readPage(context(), p, c, d)],
  ["PUT", new RegExp(`^/api/page/${SEG}/${SEG}/${SEG}$`), ([p, c, d], body) => writeNotes(context(), p, c, d, body)],
  ["POST", new RegExp(`^/api/page/${SEG}/${SEG}/${SEG}/sync$`), ([p, c, d]) => syncNotes(context(), p, c, d)],
  ["POST", new RegExp(`^/api/page/${SEG}/${SEG}$`), ([p, c]) => startPage(p, c)],

  ["GET", /^\/api\/board$/, (_, __, url) => board(context(), url.searchParams.has("refresh"))],
  ["GET", /^\/api\/issues$/, (_, __, url) => lookupIssues(context(), (url.searchParams.get("refs") ?? "").split(","))],
  ["GET", new RegExp(`^/api/issues/${SEG}/${SEG}/${SEG}$`), ([o, r, n], _, url) => {
    const ctx = context();
    return issueDetail(ctx, refFrom(ctx, o, r, n), url.searchParams.has("refresh"), url.searchParams.has("comments"));
  }],
  ["POST", new RegExp(`^/api/issues/${SEG}/${SEG}/${SEG}/status$`), ([o, r, n], body) => {
    const ctx = context();
    return setStatus(ctx, refFrom(ctx, o, r, n), body.status);
  }],

  ["GET", /^\/api\/review$/, (_, __, url) => review(context(), url.searchParams.has("refresh"))],
  ["POST", new RegExp(`^/api/review/${SEG}/merge$`), ([n]) => merge(n)],

  ["GET", /^\/api\/draft$/, () => readDraft(context())],
  ["PUT", /^\/api\/draft$/, (_, body) => saveRaw(body.text, body.hash)],
  ["PUT", /^\/api\/draft\/sections\/(\d+)$/, ([i], body) => editSection(Number(i), body)],
  ["DELETE", /^\/api\/draft\/sections\/(\d+)$/, ([i], body) => removeSection(Number(i), body)],
  ["POST", new RegExp(`^/api/draft/${SEG}$`), ([action]) => draftAction(action)],

  ["GET", /^\/api\/people$/, () => people(context())],
  ["GET", /^\/api\/setup$/, () => setup(context())],
  ["GET", /^\/api\/doctor$/, (_, __, url) => doctor(url.searchParams.has("refresh"))],
];

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

/**
 * Only this app's own pages may call it: the Host must be ours (DNS rebinding), a present Origin
 * must be ours (other sites), and writes must be JSON, which a plain cross-site form can't send.
 */
function refuse(req: Request, port: number): string | undefined {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!hosts.includes(req.headers.get("host") ?? "")) return "This app only answers on 127.0.0.1.";
  const origin = req.headers.get("origin");
  if (origin && !hosts.some((h) => origin === `http://${h}`)) return "This app only answers its own pages.";
  if (req.method !== "GET" && req.method !== "HEAD" && !(req.headers.get("content-type") ?? "").startsWith("application/json"))
    return "Changes must be sent as application/json.";
}

const SECURITY = { "Content-Security-Policy": "default-src 'self'; img-src 'self' data:", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache" };

/** A file under public/, or undefined. "/" is index.html; nothing outside public/ or hidden is served. */
function staticFile(pathname: string): string | undefined {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  } catch {
    return undefined;
  }
  const file = normalize(join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + sep) || rel.split("/").some((p) => p.startsWith("."))) return undefined;
  return existsSync(file) && statSync(file).isFile() ? file : undefined;
}

async function handle(req: Request, port: number): Promise<Response> {
  const why = refuse(req, port);
  if (why) return json({ error: why }, 403);
  const url = new URL(req.url);

  if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
    const file = staticFile(url.pathname);
    if (file) return new Response(Bun.file(file), { headers: SECURITY });
  }

  for (const [method, pattern, handler] of routes) {
    const m = pattern.exec(url.pathname);
    if (!m || method !== req.method) continue;
    try {
      const params = m.slice(1).map((s) => (s === undefined ? s : decodeURIComponent(s)));
      const body = method === "GET" ? {} : await req.json().catch(() => {
        throw new HttpError(400, "The request body isn't valid JSON.");
      });
      return json(await handler(params as string[], body ?? {}, url));
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, ...e.extra }, e.status);
      if (e instanceof HoustonError) return json({ error: e.message }, 400);
      console.error(e);
      return json({ error: `Something broke: ${(e as Error).message}` }, 500);
    }
  }
  return json({ error: `Nothing here: ${req.method} ${url.pathname}` }, 404);
}

/** Starts the app. `port: 0` picks a free port (tests); read it back from the returned server. */
export function createServer({ port }: { port: number }) {
  const server = Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 120, fetch: (req, s) => handle(req, s.port ?? port) });
  // Notes written but not yet pushed are pushed before the app stops.
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, async () => {
      await flushNotes();
      process.exit(0);
    });
  return server;
}
