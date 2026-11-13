// Houston's local app: the frame (sidebar, top bar, overlays), hash routing, keyboard, ⌘K palette,
// the shortcut sheet, polling and the "server stopped" state. Each screen lives in js/screens/ and
// exports mount(main, route) → { refresh(force), key(e), leave(), update(route), help, poll }.
import { get, state, onDown, isDown, onWriting, cached } from "./api.js";
import { $, $$, html, raw, setHTML, I, teamBadge, tickCountdowns, tickFresh, toast, copy, openModal, closeModal, modalKey, hasModal, kbd, ago, time, setTimezone, notice, plural, fullTime, pick, statusIcon } from "./ui.js";
import { openIssue, closeIssue, loadBoard, board, onBoard, searchIssues } from "./issues.js";
import { preloadEditor } from "./editor-host.js";

const SCREENS = {
  today: () => import("./screens/today.js"),
  draft: () => import("./screens/draft.js"),
  board: () => import("./screens/board.js"),
  review: () => import("./screens/review.js"),
  people: () => import("./screens/people.js"),
  setup: () => import("./screens/setup.js"),
  page: () => import("./screens/page.js"),
};
const NAV = [
  ["today", "Today", I.home, "1", "g t"],
  ["draft", "My draft", I.draft, "2", "g d"],
  ["board", "Board", I.board, "3", "g b"],
  ["review", "Review", I.review, "4", "g r"],
  ["people", "People", I.people, "5", "g p"],
];

const main = $("#main");
let current = null; // { name, route, inst }
let today = null; // GET /api/today, for the sidebar's counts
const ui = { open: new Set(JSON.parse(localStorage.openProjects ?? "null") ?? []), openInit: !localStorage.openProjects };

// ---------- routes ----------

/** "#/p/storefront/daily/2026-11-13?x=1" → { name: "page", parts: [...], params } */
export function parseRoute(hash = location.hash) {
  const [path, query] = hash.replace(/^#\/?/, "").split("?");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  const params = Object.fromEntries(new URLSearchParams(query ?? ""));
  const name = parts[0] === "p" ? "page" : parts[0] === "issue" ? "issue" : SCREENS[parts[0]] ? parts[0] : "today";
  return { name, parts: parts.slice(1), params, hash };
}
export const go = (hash) => (location.hash === hash ? route() : (location.hash = hash));

let routing = Promise.resolve();
async function route() {
  routing = routing.then(doRoute, doRoute);
  return routing;
}
async function doRoute() {
  let r = parseRoute();
  if (r.name === "issue") {
    const [o, repo, n] = r.parts;
    if (o && repo && n) openIssue(`${o}/${repo}#${n}`);
    if (current) return;
    r = parseRoute("#/board");
  }
  if (isDown()) return;
  if (current?.name === r.name && current.inst?.update) {
    current.route = r;
    await current.inst.update(r);
    drawSidebar();
    return;
  }
  if (current?.inst?.leave) await current.inst.leave();
  if (current && !location.hash.startsWith("#/issue/")) closeIssue(); // the panel belongs to the screen it was opened on
  const mod = await SCREENS[r.name]();
  current = { name: r.name, route: r, inst: null };
  main._html = null;
  main.scrollTop = 0;
  drawSidebar();
  current.inst = mod.mount(main, r) ?? {};
  document.title = `${titleFor(r)} · Houston`;
}
const titleFor = (r) => (r.name === "page" ? `${state.ctx?.projects[r.parts[0]]?.name ?? r.parts[0]} · ${cadenceTitle(r.parts[0], r.parts[1])}` : NAV.find((n) => n[0] === r.name)?.[1] ?? "Setup");
const cadenceTitle = (p, c) => state.ctx?.projects[p]?.cadences.find((x) => x.name === c)?.title ?? c;

// ---------- sidebar ----------

const rail = () => $("#app").classList.contains("side-collapsed");

function runFreshness(run = state.ctx?.lastRun) {
  if (!run) return { cls: "none", text: "No run yet on this laptop" };
  const age = Date.now() - Date.parse(run.at);
  const every = state.ctx?.runsEveryMs || 3 * 3600_000;
  if (run.outcome === "failed") return { cls: "bad", text: `Last run ${ago(run.at)} · failed` };
  if (age > every * 2.5) return { cls: "warn", text: `Last run ${ago(run.at)} · ${run.outcome}` };
  return { cls: "", text: `Last run ${ago(run.at)} · ${run.outcome === "quiet" ? "nothing new" : "ok"}` };
}

function drawSidebar() {
  const ctx = state.ctx;
  if (!ctx) return;
  const r = current?.route ?? parseRoute();
  const collapsed = rail();
  const d = today?.draft;
  const attention = today?.attention.people ?? [];
  const needs = (d ? 1 : 0) + (today?.intakePrs ?? 0) + (ctx.lastRun?.outcome === "failed" ? 1 : 0);
  const open = board.data ? board.data.columns.reduce((n, c) => n + c.cards.length, 0) : null;
  const peopleCls = attention.some((p) => p.health.level === "bad") ? "bad" : attention.length ? "warn" : "";
  const meta = {
    today: needs ? html`<span class="count">${needs}</span>` : "",
    draft: d ? (d.held ? html`<span class="nav-meta">Held</span>` : d.publishesAt ? html`<span class="nav-meta countdown short" data-countdown="${JSON.stringify({ p: d.publishesAt, h: d.held, e: d.edited, o: d.status === "overdue" })}"></span>` : html`<span class="nav-meta">${d.edited ? "Edited" : "Waiting"}</span>`) : "",
    board: open != null ? html`<span class="count">${open}</span>` : "",
    review: today?.intakePrs ? html`<span class="count">${today.intakePrs}</span>` : "",
    people: attention.length ? html`<span class="count ${peopleCls}">${plural(attention.length, "issue")}</span>` : "",
  };
  const item = ([name, label, icon, digit]) =>
    html`<a class="nav" href="#/${name}" ${r.name === name ? raw('aria-current="page"') : ""} title="${label} (${digit})" aria-label="${label}">${icon}<span class="nav-label">${label}</span>${meta[name]}${collapsed && name === "draft" && d ? html`<span class="badge-dot"></span>` : ""}</a>`;

  const projects = Object.entries(ctx.projects);
  const mine = projects.filter(([id]) => ctx.mine.includes(id));
  const others = projects.filter(([id]) => !ctx.mine.includes(id));
  if (ui.openInit) mine.forEach(([id]) => ui.open.add(id));
  const pageOf = (p, c) => today?.pages.find((x) => x.project === p && x.cadence === c);
  const cadRow = (pid, c, indent = true) => {
    const pg = pageOf(pid, c.name);
    const active = r.name === "page" && r.parts[0] === pid && r.parts[1] === c.name;
    const when = pg ? (pg.meetsToday ? "today" : pg.meetsAt ? new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: ctx.timezone }).format(new Date(pg.meetsAt)) : "") : "";
    return html`<a class="nav ${indent ? "sub" : ""}" href="#/p/${pid}/${c.name}" ${active ? raw('aria-current="page"') : ""} title="${ctx.projects[pid].name} · ${c.title}">${indent ? "" : I.page}<span class="nav-label">${c.title}</span>${pg?.counts.blocked ? html`<span class="nav-meta bad" title="${plural(pg.counts.blocked, "blocked line")}">${pg.counts.blocked} blocked</span>` : html`<span class="nav-meta">${when}</span>`}</a>`;
  };
  const projBlock = ([id, p]) => {
    const expanded = ui.open.has(id);
    const pages = today?.pages.filter((x) => x.project === id) ?? [];
    const blocked = pages.reduce((n, x) => n + x.counts.blocked, 0);
    const active = r.name === "page" && r.parts[0] === id;
    return html`<button class="nav proj" data-act="toggle-project" data-id="${id}" aria-expanded="${expanded}" title="${p.name}" ${active && (collapsed || !expanded) ? raw('aria-current="page"') : ""}>
        ${collapsed ? teamBadge(p.name, "sm") : html`<span class="chev">${I.chevron}</span>`}<span class="nav-label">${p.name}</span>${blocked ? html`<span class="badge-dot" title="${plural(blocked, "blocked line")} today"></span>` : ""}</button>
      ${expanded ? html`<div class="proj-cads side-group">${p.cadences.map((c) => cadRow(id, c))}</div>` : ""}`;
  };
  const single = projects.length === 1;
  const fr = runFreshness();
  const theme = localStorage.theme || "system";
  setHTML(
    $("#side"),
    html`<div class="side-top">
      <div class="side-team"><button class="switcher" data-act="team-menu" aria-label="${ctx.team}: team menu" title="${ctx.team}">${teamBadge(ctx.team)}<span class="nav-label">${ctx.team}</span>${I.chevronsUpDown}</button></div>
      ${collapsed ? "" : html`<button class="icon-btn" data-act="side" title="Collapse sidebar ([)" aria-label="Collapse sidebar">${I.panel}</button>`}
    </div>
    <div class="side-scroll">
      <div class="side-group">${NAV.map(item)}</div>
      ${
        single
          ? html`<div class="side-head">Pages</div><div class="side-group">${projects[0][1].cadences.map((c) => cadRow(projects[0][0], c, false))}</div>`
          : html`<div class="side-head">Projects</div><div class="side-group">${mine.map(projBlock)}</div>
            ${others.length ? html`<div class="side-head">Other projects</div><div class="side-group">${others.map(projBlock)}</div>` : ""}`
      }
    </div>
    <div class="side-foot">
      <a class="nav" href="#/setup" ${r.name === "setup" ? raw('aria-current="page"') : ""} title="Setup (g s)" aria-label="Setup">${I.settings}<span class="nav-label">Setup</span></a>
      <div class="side-row">
        <button class="sync" data-act="run-info" title="${fr.text}. Details">${html`<span class="dot ${fr.cls}"></span><span>${fr.text}</span>`}</button>
        ${collapsed ? html`<button class="icon-btn" data-act="side" title="Expand sidebar ([)" aria-label="Expand sidebar">${I.panel}</button>` : ""}
        <button class="icon-btn" data-act="theme" title="Theme: ${theme} (t)" aria-label="Theme: ${theme}. Change">${{ system: I.monitor, light: I.sun, dark: I.moon }[theme]}</button>
        <button class="icon-btn" data-act="help" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">${I.keyboard}</button>
      </div>
    </div>`,
  );
  tickCountdowns($("#side"));
}

function toggleSide() {
  localStorage.sideCollapsed = $("#app").classList.toggle("side-collapsed") ? "1" : "";
  drawSidebar();
}

async function teamMenu() {
  const ctx = state.ctx;
  const url = ctx.repo ? `https://github.com/${ctx.repo}` : null;
  const opts = [["setup", "Setup", I.settings], ...(url ? [["open", "Open repo on GitHub", I.external], ["copy", "Copy repo link", I.copy]] : [])];
  const v = await pick(ctx.team, opts);
  if (v === "setup") go("#/setup");
  else if (v === "open") window.open(url, "_blank", "noreferrer");
  else if (v === "copy") copy(url, "Repo link copied");
}

function runInfo(btn) {
  const run = state.ctx.lastRun;
  const fr = runFreshness();
  const next = run && state.ctx.runsEveryMs ? new Date(Date.parse(run.at) + state.ctx.runsEveryMs).toISOString() : null;
  const r = btn.getBoundingClientRect();
  openModal(
    html`<div class="scrim clear" data-close></div>
    <div class="popover" role="dialog" aria-modal="true" aria-label="Your last run" tabindex="-1">
      <h3>Your last run</h3>
      ${
        run
          ? html`<p><span class="chip ${fr.cls === "bad" ? "bad" : fr.cls === "warn" ? "warn" : "ok"}"><span class="dot ${fr.cls}"></span>${run.outcome}</span> <span class="mute">${fullTime(run.at)} (${ago(run.at)})</span></p>
            ${run.note ? html`<p class="${run.outcome === "failed" ? "err" : ""}">${run.note}</p>` : ""}
            ${run.sources ? html`<div class="src-list">${Object.entries(run.sources).map(([k, v]) => html`<div><span class="dot ${v === "ok" ? "" : "bad"}"></span>${k}: ${v}</div>`)}</div>` : ""}
            ${next ? html`<p class="mute small">Next run about ${time(next)}.</p>` : ""}
            ${run.outcome === "failed" ? html`<p class="mute small">See why: ${copyCmdHTML("houston doctor")}</p>` : ""}`
          : html`<p class="mute">No run on this laptop yet. Run it once to see your first draft:</p><p>${copyCmdHTML("houston run")}</p>`
      }
    </div>`,
  );
  const pop = $("#overlay .popover");
  pop.style.left = `${Math.max(8, r.left)}px`;
  pop.style.bottom = `${innerHeight - r.top + 8}px`;
}
const copyCmdHTML = (cmd) => html`<button class="copy-cmd" data-copy="${cmd}" title="Copy">${cmd}${I.copy}</button>`;

// ---------- theme ----------

const darkMedia = matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
  const t = localStorage.theme || "system";
  const root = document.documentElement;
  root.classList.add("no-transitions");
  root.classList.toggle("dark", t === "dark" || (t === "system" && darkMedia.matches));
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("no-transitions")));
}
darkMedia.addEventListener("change", applyTheme);
function cycleTheme() {
  const order = ["system", "light", "dark"];
  localStorage.theme = order[(order.indexOf(localStorage.theme || "system") + 1) % 3];
  applyTheme();
  drawSidebar();
  toast(`Theme: ${localStorage.theme}`);
}

// ---------- ⌘K palette ----------

function palette() {
  const ctx = state.ctx;
  const goto = [
    ...NAV.map(([n, label, icon, digit]) => ({ group: "Go to", label, icon, meta: digit, run: () => go(`#/${n}`) })),
    ...Object.entries(ctx.projects).flatMap(([pid, p]) =>
      p.cadences.map((c) => {
        const pg = today?.pages.find((x) => x.project === pid && x.cadence === c.name);
        return { group: "Go to", label: `${p.name} · ${c.title}`, icon: I.page, meta: pg?.meetsToday ? "today" : "", run: () => go(`#/p/${pid}/${c.name}`) };
      }),
    ),
    { group: "Go to", label: "Setup", icon: I.settings, meta: "g s", run: () => go("#/setup") },
  ];
  const acts = [
    ...(today?.draft ? [{ group: "Actions", label: "Approve & publish my draft", icon: I.send, run: () => go("#/draft?approve=1") }, { group: "Actions", label: today.draft.held ? "Release my draft" : "Hold my draft", icon: I.pause, run: () => go("#/draft?hold=1") }] : []),
    { group: "Actions", label: "Refresh this screen", icon: I.refresh, meta: "r", run: () => current?.inst?.refresh?.(true) },
    { group: "Actions", label: "Change theme", icon: I.sun, meta: "t", run: cycleTheme },
    { group: "Actions", label: "Collapse or expand the sidebar", icon: I.panel, meta: "[", run: toggleSide },
    ...(ctx.repo ? [{ group: "Actions", label: "Copy repo link", icon: I.copy, run: () => copy(`https://github.com/${ctx.repo}`, "Repo link copied") }] : []),
    { group: "Actions", label: "Keyboard shortcuts", icon: I.keyboard, meta: "?", run: help },
  ];
  let hi = 0;
  let found = [];
  openModal(
    html`<div class="scrim" data-close></div>
    <div class="menu picker" role="dialog" aria-modal="true" aria-label="Command palette">
      <label class="input wide">${I.search}<input id="pal-q" placeholder="Go to a screen or page, find an issue, run an action…" autocomplete="off" aria-label="Search" aria-controls="pal-list"></label>
      <div id="pal-list" class="opt-list" role="listbox"></div>
    </div>`,
    {
      key(e) {
        if (e.key === "ArrowDown") hi = Math.min(found.length - 1, hi + 1);
        else if (e.key === "ArrowUp") hi = Math.max(0, hi - 1);
        else if (e.key === "Enter") return e.preventDefault(), choose(hi);
        else return;
        e.preventDefault();
        draw();
        $("#pal-list .opt.hi")?.scrollIntoView({ block: "nearest" });
      },
      click(e) {
        const b = e.target.closest("[data-pick]");
        if (b) choose(Number(b.dataset.pick));
      },
    },
  );
  const choose = (n) => {
    const it = found[n];
    closeModal();
    it?.run();
  };
  const draw = () => {
    const q = $("#pal-q")?.value.trim().toLowerCase() ?? "";
    const match = (it) => !q || q.split(/\s+/).every((w) => it.label.toLowerCase().includes(w));
    const issues = (q ? searchIssues(q).slice(0, 8) : []).map((c) => ({ group: "Issues", label: c.title, icon: statusIcon(c.status ?? "none"), ident: c.ident, run: () => openIssue(c.ref) }));
    found = [...goto.filter(match), ...issues, ...acts.filter(match)];
    hi = Math.min(hi, Math.max(0, found.length - 1));
    let last;
    setHTML(
      $("#pal-list"),
      found.length
        ? found.map((it, n) => {
            const head = it.group !== last ? html`<div class="menu-title">${it.group}</div>` : "";
            last = it.group;
            return html`${head}<button class="opt ${n === hi ? "hi" : ""}" data-pick="${n}" role="option" aria-selected="${n === hi}">${it.icon}${it.ident ? html`<span class="ident">${it.ident}</span>` : ""}<span>${it.label}</span>${it.meta ? html`<span class="meta">${it.meta}</span>` : ""}</button>`;
          })
        : html`<p class="mute pad">${board.loading ? "Loading issues…" : "Nothing matches."}</p>`,
    );
  };
  $("#pal-q").oninput = () => ((hi = 0), draw());
  draw();
  loadBoard().then(() => hasModal() && $("#pal-q") && draw(), () => {});
}

// ---------- shortcut sheet ----------

const GLOBAL_KEYS = [
  ["⌘ K", "Command palette"],
  ["⌘ ⇧ K", "Command palette while writing Notes (⌘ K links an issue there)"],
  ["1 – 5", "Today, My draft, Board, Review, People"],
  ["g then t d b r p s", "Go to Today, Draft, Board, Review, People, Setup"],
  ["[", "Collapse / expand the sidebar"],
  ["t", "Change theme"],
  ["r", "Refresh this screen"],
  ["?", "This sheet"],
  ["Esc", "Close a panel or dialog; leave the editor"],
];
function help() {
  const screen = current?.inst?.help ?? [];
  const rows = (list) => list.map(([k, d]) => html`<div class="help-row"><span>${d}</span><span>${k.split(" ").filter((x) => x !== "then").map(kbd)}</span></div>`);
  openModal(
    html`<div class="scrim" data-close></div>
    <div class="menu help" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" tabindex="-1">
      <div class="help-cols"><div><div class="menu-title">Everywhere</div>${rows(GLOBAL_KEYS)}</div>
      <div><div class="menu-title">${screen.length ? `On ${titleFor(current.route)}` : "This screen"}</div>${screen.length ? rows(screen) : html`<p class="mute pad small">No extra keys here.</p>`}</div></div>
    </div>`,
  );
}

// ---------- keyboard ----------

let gPressed = 0;
document.addEventListener("keydown", (e) => {
  if (modalKey(e)) return;
  const t = e.target;
  const mod = e.metaKey || e.ctrlKey;
  const typing = t.matches?.("input, textarea, select") || t.isContentEditable;
  if (mod && e.key.toLowerCase() === "k" && (e.shiftKey || !typing)) {
    e.preventDefault();
    return palette();
  }
  if (!typing && !mod && gPressed && Date.now() - gPressed < 1200) {
    gPressed = 0;
    const to = { t: "today", d: "draft", b: "board", r: "review", p: "people", s: "setup" }[e.key];
    if (to) return e.preventDefault(), go(`#/${to}`);
  }
  if (!typing && !mod && e.key === "g") return (gPressed = Date.now());
  if (current?.inst?.key?.(e, typing)) return;
  if (typing) {
    if (e.key === "Escape") t.blur();
    return;
  }
  if (mod || e.altKey) return;
  const n = NAV.find((x) => x[3] === e.key);
  if (n) return e.preventDefault(), go(`#/${n[0]}`);
  const run = {
    "[": toggleSide,
    t: cycleTheme,
    r: () => current?.inst?.refresh?.(true),
    "?": help,
    Escape: () => closeIssue(),
  }[e.key];
  if (run) {
    e.preventDefault();
    run();
  }
});

// ---------- clicks ----------

const actions = {
  side: toggleSide,
  "side-open": () => $("#app").classList.toggle("side-open"),
  theme: cycleTheme,
  help,
  "team-menu": teamMenu,
  "run-info": runInfo,
  refresh: () => current?.inst?.refresh?.(true),
  "toggle-project": (b) => {
    const id = b.dataset.id;
    ui.open.has(id) ? ui.open.delete(id) : ui.open.add(id);
    ui.openInit = false;
    localStorage.openProjects = JSON.stringify([...ui.open]);
    if (rail()) go(`#/p/${id}/${state.ctx.projects[id].cadences[0].name}`);
    drawSidebar();
  },
  "dismiss-flash": (b) => b.closest(".notice")?.remove(),
};
document.addEventListener("click", (e) => {
  const c = e.target.closest("[data-copy]");
  if (c) return copy(c.dataset.copy, `Copied: ${c.dataset.copy}`);
  const a = e.target.closest("[data-act]");
  if (a && actions[a.dataset.act] && !a.closest("#detail")) {
    e.preventDefault();
    actions[a.dataset.act](a);
  }
  if (e.target.closest("#side a.nav")) $("#app").classList.remove("side-open");
});
$("#side").addEventListener("pointerenter", preloadEditor, { once: true });

// Errors from actions anywhere (issues.js dispatches these): pinned until dismissed.
document.addEventListener("houston:error", (e) => {
  const el = document.createElement("div");
  el.innerHTML = String(notice("err", e.detail, html`<button class="icon-btn" data-act="dismiss-flash" aria-label="Dismiss">${I.x}</button>`));
  $("#flash").append(el.firstElementChild);
});

// ---------- resizable panels ----------

const SIZES = { side: [200, 420, 256], detail: [380, 960, 544], updates: [320, 560, 380] };
function applySizes() {
  for (const [k, [, , def]] of Object.entries(SIZES)) document.documentElement.style.setProperty(`--${k}-w`, `${Number(localStorage[`${k}W`]) || def}px`);
}
document.addEventListener("pointerdown", (e) => {
  const h = e.target.closest?.("[data-resize]");
  if (!h || e.button !== 0) return;
  const k = h.dataset.resize;
  const [min, max] = SIZES[k];
  e.preventDefault();
  h.setPointerCapture(e.pointerId);
  document.body.classList.add("resizing");
  document.documentElement.classList.add("no-transitions");
  const right = h.parentElement.getBoundingClientRect().right;
  const move = (ev) => {
    const w = k === "side" ? ev.clientX : right - ev.clientX;
    localStorage[`${k}W`] = Math.round(Math.min(max, Math.max(min, w)));
    applySizes();
  };
  const up = () => {
    h.removeEventListener("pointermove", move);
    h.removeEventListener("pointerup", up);
    document.body.classList.remove("resizing");
    document.documentElement.classList.remove("no-transitions");
  };
  h.addEventListener("pointermove", move);
  h.addEventListener("pointerup", up);
});
document.addEventListener("dblclick", (e) => {
  const h = e.target.closest?.("[data-resize]");
  if (!h) return;
  delete localStorage[`${h.dataset.resize}W`];
  applySizes();
});

// ---------- server down ----------

let downTimer;
onDown((down) => {
  clearInterval(downTimer);
  if (down) {
    current?.inst?.leave?.({ quiet: true });
    current = null;
    main._html = null;
    main.innerHTML = String(html`<div class="down" role="alert"><div class="down-card">${I.wifiOff}
      <h2>The Houston app stopped</h2>
      <p class="mute">Start it again in the Houston repo, and this page picks up where it was:</p>
      ${copyCmdHTML("houston app")}
      <p class="mute small">Checking every 5 seconds… <button class="btn xs outline" data-act="retry-down">Retry now</button></p></div></div>`);
    downTimer = setInterval(() => get("/context").catch(() => {}), 5000);
  } else {
    boot();
  }
});
actions["retry-down"] = () => get("/context").catch(() => {});

// Write buttons wait while another write runs (the server queues git writes; this avoids double clicks).
onWriting((on) => {
  document.body.classList.toggle("writing", on);
  for (const b of $$("[data-write]")) if (!b.classList.contains("busy")) b.disabled = on;
});

// ---------- polling and boot ----------

async function refreshFrame() {
  try {
    const [ctx, t] = await Promise.all([get("/context"), get("/today")]);
    state.ctx = ctx;
    setTimezone(ctx.timezone);
    if (t.intakePrs === null && today?.intakePrs != null) t.intakePrs = today.intakePrs; // not reloaded yet: keep the last count
    today = t;
    drawSidebar();
    if (t.intakePrs === null) setTimeout(() => get("/today").then((x) => ((today = x), drawSidebar())).catch(() => {}), 2500);
  } catch {
    /* down state handles it */
  }
}
export const frameData = () => today;
export const refreshSidebar = refreshFrame;

let booted = false;
async function boot() {
  try {
    state.ctx = await get("/context");
  } catch {
    return;
  }
  setTimezone(state.ctx.timezone);
  today = cached("/today") ?? null;
  drawSidebar();
  refreshFrame();
  await route();
  if (booted) return;
  booted = true;
  addEventListener("hashchange", route);
  onBoard(drawSidebar);
  setInterval(() => !document.hidden && !isDown() && refreshFrame(), 60_000);
  setInterval(() => {
    tickCountdowns();
    tickFresh();
  }, 15_000);
  // Each screen polls at its own pace (page 60 s, draft 30 s…) while it's visible.
  setInterval(() => {
    const inst = current?.inst;
    if (!inst?.poll || document.hidden || hasModal() || isDown()) return;
    inst._t = (inst._t ?? 0) + 5;
    if (inst._t >= inst.poll) {
      inst._t = 0;
      inst.refresh?.(false);
    }
  }, 5000);
  addEventListener("beforeunload", () => current?.inst?.leave?.({ unload: true }));
}

document.addEventListener("houston:panel", (e) => {
  if (!e.detail && location.hash.startsWith("#/issue/")) history.replaceState(null, "", "#/board");
});
// After any screen renders, keep its timers right.
new MutationObserver(() => {
  tickCountdowns(main);
  tickFresh(main);
}).observe(main, { childList: true, subtree: true });

applySizes();
$("#app").classList.toggle("side-collapsed", !!localStorage.sideCollapsed);
applyTheme();
boot();

