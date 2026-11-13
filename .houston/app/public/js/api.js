// Talking to the server (see docs/app.md). One fetch wrapper that:
// - sends writes as JSON (the server refuses anything else),
// - turns error responses into ApiError carrying the status and any extra fields (409 `theirs`, …),
// - tells the app when the server is unreachable (fetch rejects) so it can show "The Houston app stopped",
// - remembers the last good answer per GET path, so a screen can draw cached data at once and refresh.

export class ApiError extends Error {
  constructor(status, data) {
    super(data?.error ?? `The server answered ${status}.`);
    this.status = status;
    this.data = data ?? {};
  }
}
export class DownError extends Error {
  constructor() {
    super("The Houston app isn't answering.");
    this.down = true;
  }
}

const listeners = new Set();
/** Called with true when the server stops answering and false when it's back. */
export const onDown = (fn) => listeners.add(fn);
let down = false;
const setDown = (v) => {
  if (down === v) return;
  down = v;
  for (const fn of listeners) fn(v);
};
export const isDown = () => down;

const cache = new Map(); // GET path -> { data, at }
export const cached = (path) => cache.get(path)?.data;
export const cachedAt = (path) => cache.get(path)?.at;
export const forget = (prefix) => {
  for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k);
};

let writes = 0;
const writeListeners = new Set();
/** Writes in flight; the UI disables other write buttons meanwhile (spec "Busy"). */
export const writing = () => writes > 0;
export const onWriting = (fn) => writeListeners.add(fn);
const bump = (d) => {
  writes += d;
  for (const fn of writeListeners) fn(writes > 0);
};

export async function api(path, { method = "GET", body } = {}) {
  const write = method !== "GET";
  if (write) bump(1);
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: write ? { "Content-Type": "application/json" } : {},
      body: write ? JSON.stringify(body ?? {}) : undefined,
    });
  } catch {
    if (write) bump(-1);
    setDown(true);
    throw new DownError();
  }
  if (write) bump(-1);
  setDown(false);
  const data = await res.json().catch(() => ({ error: `The server answered ${res.status} with something that isn't JSON.` }));
  if (!res.ok) throw new ApiError(res.status, data);
  if (!write) cache.set(path, { data, at: Date.now() });
  return data;
}

export const get = (path) => api(path);
export const put = (path, body) => api(path, { method: "PUT", body });
export const post = (path, body) => api(path, { method: "POST", body });
export const del = (path, body) => api(path, { method: "DELETE", body });

/** App-wide state every screen reads: `ctx` is GET /api/context (team, user, projects, columns…). */
export const state = { ctx: null };
