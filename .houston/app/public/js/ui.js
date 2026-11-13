// Shared UI pieces: safe HTML templating, icons, status/priority icons, avatars, time formatting,
// toasts, dialogs and menus. Every string from files or GitHub goes through html`` (which escapes)
// before it reaches the DOM. The CSP forbids style="" attributes, so colours come from classes.

export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

// ---------- HTML ----------

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
class Raw {
  constructor(s) {
    this.s = s;
  }
  toString() {
    return this.s;
  }
}
export const raw = (s) => new Raw(String(s));
const show = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(show).join("") : v === false || v == null ? "" : esc(v));
/** Tagged template: interpolated values are escaped unless they're already html`` or raw(). */
export const html = (strings, ...vals) => raw(strings.reduce((out, s, i) => out + s + (i < vals.length ? show(vals[i]) : ""), ""));

/** Replace an element's content only when the markup changed, so background refreshes don't jump. */
export function setHTML(el, h) {
  const s = Array.isArray(h) ? h.join("") : String(h);
  if (!el || el._html === s) return false;
  el.innerHTML = s;
  el._html = s;
  return true;
}

// ---------- icons (lucide, inline) ----------

const lucide = (paths, size = 16) =>
  raw(`<svg class="lucide" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`);
export const I = {
  sun: lucide(`<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2m-7.07-17.07 1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>`),
  moon: lucide(`<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>`),
  monitor: lucide(`<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8M12 17v4"/>`),
  keyboard: lucide(`<path d="M10 8h.01M12 12h.01M14 8h.01M16 12h.01M18 8h.01M6 8h.01M7 16h10M8 12h.01"/><rect width="20" height="16" x="2" y="4" rx="2"/>`),
  panel: lucide(`<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>`),
  home: lucide(`<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>`),
  draft: lucide(`<path d="M12 20h9"/><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z"/>`),
  board: lucide(`<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18M15 3v18"/>`),
  list: lucide(`<path d="M3 12h.01M3 18h.01M3 6h.01M8 12h13M8 18h13M8 6h13"/>`),
  review: lucide(`<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M6 9v12"/>`),
  people: lucide(`<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>`),
  settings: lucide(`<path d="M20 7h-9M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>`),
  page: lucide(`<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4M10 13H8M16 17H8M16 13h-2"/>`),
  calendar: lucide(`<path d="M8 2v4M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>`),
  refresh: lucide(`<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>`, 14),
  x: lucide(`<path d="M18 6 6 18M6 6l12 12"/>`),
  external: lucide(`<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>`, 14),
  search: lucide(`<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>`, 14),
  chevron: lucide(`<path d="m9 18 6-6-6-6"/>`, 14),
  chevronLeft: lucide(`<path d="m15 18-6-6 6-6"/>`),
  chevronRight: lucide(`<path d="m9 18 6-6-6-6"/>`),
  chevronsUpDown: lucide(`<path d="m7 15 5 5 5-5M7 9l5-5 5 5"/>`, 14),
  link: lucide(`<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>`, 14),
  lock: lucide(`<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>`, 14),
  clock: lucide(`<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>`, 14),
  alert: lucide(`<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/>`),
  alertCircle: lucide(`<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>`),
  info: lucide(`<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>`),
  check: lucide(`<path d="M20 6 9 17l-5-5"/>`, 14),
  checkCircle: lucide(`<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>`),
  plus: lucide(`<path d="M5 12h14M12 5v14"/>`, 14),
  pencil: lucide(`<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>`, 14),
  trash: lucide(`<path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>`, 14),
  more: lucide(`<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>`),
  copy: lucide(`<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>`, 13),
  message: lucide(`<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>`, 14),
  note: lucide(`<path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z"/><path d="M15 3v6h6"/>`, 14),
  sparkle: lucide(`<path d="M9.94 14.06 4 20M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2Z"/>`, 14),
  pause: lucide(`<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>`, 14),
  play: lucide(`<path d="m6 3 14 9-14 9V3z"/>`, 14),
  send: lucide(`<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>`, 14),
  ban: lucide(`<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>`, 14),
  gitMerge: lucide(`<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>`, 14),
  user: lucide(`<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>`, 14),
  tag: lucide(`<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>`, 14),
  terminal: lucide(`<path d="m4 17 6-6-6-6M12 19h8"/>`, 14),
  menu: lucide(`<path d="M4 12h16M4 6h16M4 18h16"/>`),
  inbox: lucide(`<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>`),
  wifiOff: lucide(`<path d="M12 20h.01M8.5 16.43a5 5 0 0 1 7 0M2 8.82a15 15 0 0 1 4.17-2.65M10.66 5c4.01-.36 8.14.9 11.34 3.76M16.85 11.25a10 10 0 0 1 2.22 1.68M5 13a10 10 0 0 1 5.24-2.76M2 2l20 20"/>`),
  h2: lucide(`<path d="M4 12h8M4 18V6M12 18V6M21 18h-4c0-4 4-3 4-6 0-1.5-2-2.5-4-1"/>`),
  h3: lucide(`<path d="M4 12h8M4 18V6M12 18V6M17.5 10.5c1.7-1 3.5 0 3.5 1.5a2 2 0 0 1-2 2M17 17.5c2 1.5 4 .3 4-1.5a2 2 0 0 0-2-2"/>`),
  bold: lucide(`<path d="M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8"/>`),
  italic: lucide(`<path d="M19 4h-9M14 20H5M15 4 9 20"/>`),
  bullet: lucide(`<path d="M3 12h.01M3 18h.01M3 6h.01M8 12h13M8 18h13M8 6h13"/>`),
  ordered: lucide(`<path d="M10 12h11M10 18h11M10 6h11M4 10h2M4 6h1v4M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>`),
  task: lucide(`<path d="m3 17 2 2 4-4M3 7l2 2 4-4M13 6h8M13 12h8M13 18h8"/>`),
};

const svg = (inner) => raw(`<svg class="ico" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">${inner}</svg>`);

/** Status icon (MC's, plus in-review, blocked, ready-for-agent). `closed` wins: a closed issue is done. */
export function statusIcon(s, closed = false) {
  if (closed) s = "done";
  const c = `var(--s-${s || "none"})`;
  return svg(
    {
      backlog: `<circle cx="7" cy="7" r="5.5" fill="none" stroke="${c}" stroke-width="1.5" stroke-dasharray="1.6 2.05"/>`,
      todo: `<circle cx="7" cy="7" r="5.5" fill="none" stroke="${c}" stroke-width="1.5"/>`,
      "in-progress": `<circle cx="7" cy="7" r="5.5" fill="none" stroke="${c}" stroke-width="1.5"/><path d="M7 3.5a3.5 3.5 0 0 1 0 7z" fill="${c}"/>`,
      "in-review": `<circle cx="7" cy="7" r="5.5" fill="none" stroke="${c}" stroke-width="1.5"/><path d="M7 3.5a3.5 3.5 0 1 1-3.5 3.5H7z" fill="${c}"/>`,
      blocked: `<circle cx="7" cy="7" r="5.5" fill="none" stroke="${c}" stroke-width="1.5"/><path d="M4.4 7h5.2" stroke="${c}" stroke-width="1.8" stroke-linecap="round"/>`,
      "ready-for-agent": `<circle cx="7" cy="7" r="5.5" fill="none" stroke="${c}" stroke-width="1.5"/><circle cx="7" cy="7" r="2" fill="${c}"/>`,
      done: `<circle cx="7" cy="7" r="6.25" fill="${c}"/><path d="M4.4 7.2l1.8 1.8 3.4-3.6" fill="none" stroke="var(--background)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
      none: `<circle cx="7" cy="7" r="5.5" fill="none" stroke="${c}" stroke-width="1.2" stroke-dasharray="1 2.4"/>`,
    }[s] ?? `<circle cx="7" cy="7" r="5.5" fill="none" stroke="${c}" stroke-width="1.5"/>`,
  );
}

export function prioIcon(p) {
  if (p === "p0") return svg(`<rect x="1" y="1" width="12" height="12" rx="3" fill="var(--error)"/><path d="M7 3.8v3.7" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/><circle cx="7" cy="10" r=".95" fill="#fff"/>`);
  if (!p) return svg(`<path d="M2.5 7h1.5M6.25 7h1.5M10 7h1.5" stroke="var(--muted-foreground)" stroke-width="1.5" stroke-linecap="round"/>`);
  const lvl = { p1: 3, p2: 2, p3: 1 }[p];
  return svg([4, 7, 10].map((h, n) => `<rect x="${1.5 + n * 4}" y="${12 - h}" width="3" height="${h}" rx="1" fill="${n < lvl ? "var(--foreground)" : "var(--input)"}"/>`).join(""));
}

// ---------- avatars ----------

export const hue = (s) => {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 12;
};
const initials = (login) => {
  const parts = String(login).replace(/[^a-zA-Z0-9]+/g, " ").trim().split(" ");
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : String(login).slice(0, 2)).toUpperCase();
};
export const avatar = (login, cls = "") =>
  login ? html`<span class="av ${cls} hue-${hue(login)}" title="${login}" aria-hidden="true">${initials(login)}</span>` : html`<span class="av av-none ${cls}" aria-hidden="true"></span>`;
export const teamBadge = (name, cls = "") => html`<span class="team-badge ${cls} hue-${hue(name)}" aria-hidden="true">${(name || "?")[0].toUpperCase()}</span>`;

// ---------- time (in the person's timezone from /api/context) ----------

let TZ;
export const setTimezone = (tz) => {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    TZ = tz;
  } catch {
    TZ = undefined;
  }
};
const fmt = (opts) => new Intl.DateTimeFormat(undefined, { timeZone: TZ, ...opts });
export const time = (iso) => (iso ? fmt({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso)) : "");
export const dayTime = (iso) => (iso ? fmt({ weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso)) : "");
export const fullTime = (iso) => (iso ? fmt({ dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)) : "");
const dayDate = (d) => new Date(`${d}T12:00:00Z`);
/** "Fri 13 Nov" from "2026-11-13". */
export const shortDay = (d) => (d ? new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(dayDate(d)) : "");
/** "Friday, 13 November" from "2026-11-13". */
export const longDay = (d) => (d ? new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(dayDate(d)) : "");
export const monthDay = (iso) => (iso ? fmt({ month: "short", day: "numeric" }).format(new Date(iso)) : "");
/** Local "YYYY-MM-DD" for an instant, in the person's timezone. */
export const isoDay = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

export function ago(iso) {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
/** "in 23m" / "in 2h 5m" / "8m ago". */
export function rel(iso) {
  const ms = Date.parse(iso) - Date.now();
  const m = Math.round(Math.abs(ms) / 60000);
  const span = m < 1 ? "under a minute" : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}` : `${Math.round(m / 1440)}d`;
  return ms >= 0 ? `in ${span}` : m < 1 ? "just now" : `${span} ago`;
}
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---------- deadline countdown ----------

/**
 * The draft deadline component. Renders an element the 15 s ticker re-computes, so every countdown
 * on screen (top bar, Today card, sidebar) stays right without re-rendering the screen.
 */
export function countdown(d, size = "") {
  if (!d) return "";
  return html`<span class="countdown ${size}" data-countdown="${JSON.stringify({ p: d.publishesAt, h: d.held, e: d.edited, o: d.overdue || d.status === "overdue", m: d.mode, dl: d.deadlineAt })}" role="timer"></span>`;
}
export function countdownState({ p, h, e, o, m, dl }, short = false) {
  if (h) return { cls: "held", text: short ? "Held" : "Held · won't publish until you release it", dot: "held" };
  if (o) return { cls: "warn", text: short ? "Overdue" : "Overdue · publishes at your next run", dot: "warn" };
  if (!p) return { cls: "", text: m === "review" || !dl ? (short ? "Waiting" : "Waiting for you · no deadline") : "", dot: "none" };
  const mins = (Date.parse(p) - Date.now()) / 60000;
  const r = rel(p);
  const at = time(p);
  if (mins <= 0) return { cls: "bad", text: short ? "now" : `Publishing now · ${at}`, dot: "bad pulse" };
  const cls = mins < 5 ? "bad" : mins < 15 ? "warn" : "";
  const text = short ? r : e ? `Edited · publishes ${r} as you left it · ${at}` : `Publishes ${r} · ${at}`;
  return { cls, text, dot: mins < 5 ? "bad pulse" : mins < 15 ? "warn" : "none" };
}
export function tickCountdowns(root = document) {
  for (const el of $$("[data-countdown]", root)) {
    const s = countdownState(JSON.parse(el.dataset.countdown), el.classList.contains("short"));
    el.classList.remove("warn", "bad", "held");
    if (s.cls) el.classList.add(s.cls);
    const h = `<span class="dot ${s.dot}"></span>${esc(s.text)}`;
    if (el._html !== h) {
      el.innerHTML = h;
      el._html = h;
    }
  }
}

// ---------- small components ----------

export const kbd = (k) => html`<kbd>${k}</kbd>`;
export const skeletonRows = (n = 8) =>
  html`<div class="sk-rows" aria-busy="true" aria-label="Loading">${Array.from({ length: n }, (_, i) => html`<div class="sk-row"><span class="sk w30"></span><span class="sk grow ${["w60", "w80", "w50", "w70"][i % 4]}"></span></div>`)}</div>`;
export const skeletonBlock = (n = 5) =>
  html`<div class="sk-col" aria-busy="true" aria-label="Loading"><span class="sk h28"></span>${Array.from({ length: n }, (_, i) => html`<span class="sk ${["w90", "w70", "w80", "w50", "w60"][i % 5]}"></span>`)}</div>`;

/** Inline notice. kind: "" (warning) | "err" | "info" | "held" | "ok". */
export const notice = (kind, body, acts = "") =>
  html`<div class="notice ${kind}" role="${kind === "err" ? "alert" : "status"}">${kind === "err" ? I.alertCircle : kind === "ok" ? I.checkCircle : kind === "info" ? I.info : kind === "held" ? I.pause : I.alert}<div class="grow">${body}</div>${acts ? html`<div class="acts">${acts}</div>` : ""}</div>`;

/** Error state for a screen: what failed in plain words, what to try, and Retry. */
export const errorNotice = (e, retryAct = "refresh") =>
  notice("err", html`<b>Couldn't load this.</b> ${e?.message ?? e} ${/houston /.test(e?.message ?? "") ? "" : html`If it keeps happening, run <code>houston doctor</code> in the Houston repo.`}`, html`<button class="btn sm outline" data-act="${retryAct}">${I.refresh}Retry</button>`);

export const copyCmd = (cmd) => html`<button class="copy-cmd" data-copy="${cmd}" title="Copy">${cmd}${I.copy}</button>`;

/** Inline `code` in a plain sentence from the server (e.g. "Run `houston run`"). */
export const codeText = (s) => raw(esc(s).replace(/`([^`]+)`/g, "<code>$1</code>"));

export async function copy(text, what = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast(what);
  } catch {
    toast("Couldn't copy; select the text and copy it yourself.");
  }
}

// ---------- toast ----------

let toastTimer;
/** A success message with an optional action ("Undo", "View"). Errors go inline, not here. */
export function toast(msg, action) {
  const t = $("#toast");
  t.replaceChildren(Object.assign(document.createElement("span"), { textContent: msg }));
  if (action) {
    const b = Object.assign(document.createElement("button"), { className: "btn xs outline", textContent: action.label });
    b.onclick = () => {
      t.classList.remove("show");
      action.run();
    };
    t.append(b);
  }
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), action ? 6000 : 4000);
}

// ---------- overlays: one at a time, focus trapped, Esc closes, focus returns ----------

let modal = null;
export const hasModal = () => !!modal;

export function openModal(markup, opts = {}) {
  const restore = modal?.restore ?? document.activeElement;
  $("#overlay").innerHTML = String(markup);
  modal = { restore, ...opts };
  const first = $("#overlay [data-autofocus]") ?? $("#overlay input, #overlay .opt.hi, #overlay button.primary, #overlay button, #overlay [tabindex]");
  first?.focus();
}
export function closeModal(value) {
  if (!modal) return;
  const m = modal;
  modal = null;
  $("#overlay").innerHTML = "";
  m.onClose?.(value);
  if (m.restore?.isConnected) m.restore.focus();
}
export function modalKey(e) {
  if (!modal) return false;
  if (e.key === "Escape") {
    e.preventDefault();
    closeModal();
    return true;
  }
  if (e.key === "Tab") {
    const f = $$("#overlay button:not(:disabled), #overlay input, #overlay a[href], #overlay textarea, #overlay [tabindex]");
    if (f.length) {
      const i = f.indexOf(document.activeElement);
      const n = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : i === f.length - 1 ? 0 : i + 1;
      f[n].focus();
      e.preventDefault();
    }
    return true;
  }
  modal.key?.(e);
  return true;
}
document.addEventListener("click", (e) => {
  if (!modal || !e.target.closest("#overlay")) return;
  if (e.target.matches("[data-close]")) return closeModal();
  modal.click?.(e);
});

/** A confirm dialog (replaces confirm()). Resolves true when confirmed. */
export function confirmDialog({ title, body, confirm, danger = false, cancel = "Cancel" }) {
  return new Promise((resolve) => {
    let ok = false;
    openModal(
      html`<div class="scrim" data-close></div>
      <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dlg-t" aria-describedby="dlg-b">
        <h2 id="dlg-t">${title}</h2>
        <div class="dialog-text" id="dlg-b">${body}</div>
        <div class="dialog-foot"><button class="btn ghost" data-close ${danger ? raw("data-autofocus") : ""}>${cancel}</button><button class="btn primary ${danger ? "danger" : ""}" data-ok ${danger ? "" : raw("data-autofocus")}>${confirm}</button></div>
      </div>`,
      {
        click: (e) => e.target.closest("[data-ok]") && ((ok = true), closeModal()),
        key: (e) => e.key === "Enter" && document.activeElement?.matches("[data-ok]") && (e.preventDefault(), (ok = true), closeModal()),
        onClose: () => resolve(ok),
      },
    );
  });
}

/**
 * A keyboard menu (MC's pick): options [value, label, icon?, {danger, meta, check}]. Resolves the
 * chosen value, or undefined. j/k/arrows move, Enter picks, digits pick directly.
 */
export function pick(title, opts, cur) {
  return new Promise((resolve) => {
    let hi = Math.max(0, opts.findIndex((o) => o[0] === cur));
    let chosen;
    const draw = () => {
      setHTML(
        $("#overlay .opt-list"),
        opts.map(
          (o, n) => html`<button class="opt ${n === hi ? "hi" : ""} ${o[3]?.danger ? "danger" : ""}" data-pick="${n}" role="option" aria-selected="${o[0] === cur}">${o[2] ?? ""}<span>${o[1]}</span>${o[3]?.meta ? html`<span class="meta">${o[3].meta}</span>` : ""}${o[0] === cur ? I.check : ""}${n < 9 ? kbd(n + 1) : ""}</button>`,
        ),
      );
      $(`#overlay [data-pick="${hi}"]`)?.focus();
    };
    const choose = (n) => {
      chosen = opts[n]?.[0];
      closeModal();
    };
    openModal(html`<div class="scrim clear" data-close></div><div class="menu" role="listbox" aria-label="${title}"><div class="menu-title">${title}</div><div class="opt-list"></div></div>`, {
      key(e) {
        if (e.key === "ArrowDown" || e.key === "j") hi = (hi + 1) % opts.length;
        else if (e.key === "ArrowUp" || e.key === "k") hi = (hi - 1 + opts.length) % opts.length;
        else if (e.key === "Enter") return e.preventDefault(), choose(hi);
        else if (/^[1-9]$/.test(e.key) && opts[e.key - 1]) return e.preventDefault(), choose(e.key - 1);
        else return;
        e.preventDefault();
        draw();
      },
      click(e) {
        const p = e.target.closest("[data-pick]");
        if (p) choose(Number(p.dataset.pick));
      },
      onClose: () => resolve(chosen),
    });
    draw();
  });
}

/** Turn a button into a busy one ("Publishing…") until `fn` settles. */
export async function busy(btn, label, fn) {
  const before = btn?.innerHTML;
  if (btn) {
    btn.disabled = true;
    btn.classList.add("busy");
    btn.textContent = label;
  }
  try {
    return await fn();
  } finally {
    if (btn?.isConnected) {
      btn.disabled = false;
      btn.classList.remove("busy");
      btn.innerHTML = before;
    }
  }
}

// ---------- top bar and freshness ----------

/** The 52px top bar every screen starts with: title left, actions right. */
export const bar = (title, right = "") =>
  html`<header class="bar"><button class="icon-btn menu-btn" data-act="side-open" aria-label="Open the sidebar">${I.menu}</button><h1>${title}</h1><span class="spacer"></span>${right}</header>`;

/**
 * "Fetched 4m ago" (amber after 10 min) for GitHub-backed data; "Refreshing…" while a refresh runs.
 * Click (or r) refreshes. The ticker keeps the age current.
 */
export const freshBadge = (iso, loading = false) =>
  loading
    ? html`<span class="chip fresh" role="status"><span class="dot busy"></span>Refreshing…</span>`
    : iso
      ? html`<button class="chip fresh" data-act="refresh" data-fresh="${iso}" title="Fetched from GitHub at ${fullTime(iso)}. Refresh (r)"></button>`
      : "";
export function tickFresh(root = document) {
  for (const el of $$("[data-fresh]", root)) {
    const old = Date.now() - Date.parse(el.dataset.fresh) > 10 * 60_000;
    el.classList.toggle("warn", old);
    const h = `<span class="dot ${old ? "warn" : "none"}"></span>Fetched ${esc(ago(el.dataset.fresh))}`;
    if (el._html !== h) (el.innerHTML = h), (el._html = h);
  }
}
