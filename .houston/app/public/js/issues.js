// Issues everywhere: the board store (one cached copy shared by every screen), issue chips with live
// status and title, the docked issue panel, status moves (optimistic, with undo) and the ⌘K issue
// picker. Chips render from what's known and fill in when a batched /api/issues lookup answers.
import { get, post, state } from "./api.js";
import { $, $$, html, setHTML, I, statusIcon, prioIcon, avatar, toast, pick, openModal, closeModal, ago, skeletonBlock, errorNotice } from "./ui.js";
import { md, summaryParts } from "./markdown.js";

// ---------- cards: ref -> Card | null ----------

const cards = new Map();
const pending = new Set();
let lookupTimer;

export const cardFor = (ref) => cards.get(ref);
const identOf = (ref) => ref.replace(/^[^/]+\//, "");
export const statusName = (s) => state.ctx?.columns.find((c) => c.label === s)?.name ?? (s ? s.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase()) : "No status");

function chipInner(ref, c) {
  return c
    ? html`${statusIcon(c.status ?? "none", c.state === "closed")}<span class="ref-id">${c.ident}</span><span class="ref-title">${c.title}</span>`
    : html`<span class="ref-id">${identOf(ref)}</span>`;
}
const chipLabel = (ref, c) => (c ? `${c.ident}, ${c.state === "closed" ? "Closed" : c.statusName ?? "No status"}: ${c.title}` : `${ref}, not loaded`);
const chipClass = (c) => `issue-ref${c ? (c.state === "closed" ? " closed" : "") : " unknown"}`;

/** An issue chip as HTML (notes, updates, draft, review). Unknown refs are looked up in a batch. */
export function chipHTML(ref, extra = "") {
  const c = cards.get(ref);
  if (c === undefined) want(ref);
  const url = c?.url ?? `https://github.com/${ref.replace("#", "/issues/")}`;
  return html`<a class="${chipClass(c)} ${extra}" href="${url}" target="_blank" rel="noreferrer" data-ref="${ref}" aria-label="${chipLabel(ref, c)}" title="${chipLabel(ref, c)}">${chipInner(ref, c)}</a>`;
}
/** The same chip as an element, for the Notes editor (a non-editable atom). */
export function chipElement(ref) {
  const el = document.createElement("span");
  el.contentEditable = "false";
  el.dataset.ref = ref;
  paint(el, ref);
  if (cards.get(ref) === undefined) want(ref);
  return el;
}
function paint(el, ref) {
  const c = cards.get(ref);
  el.className = `${chipClass(c)}${el.classList.contains("wide") ? " wide" : ""}`;
  el.setAttribute("aria-label", chipLabel(ref, c));
  el.title = chipLabel(ref, c);
  setHTML(el, chipInner(ref, c));
}

function want(ref) {
  if (pending.has(ref)) return;
  pending.add(ref);
  clearTimeout(lookupTimer);
  lookupTimer = setTimeout(lookup, 30);
}
async function lookup() {
  const refs = [...pending].slice(0, 100);
  if (!refs.length) return;
  try {
    const r = await get(`/issues?refs=${refs.map(encodeURIComponent).join(",")}`);
    for (const ref of refs) cards.set(ref, r.issues[ref] ?? null);
  } catch {
    for (const ref of refs) cards.set(ref, null);
  }
  for (const ref of refs) pending.delete(ref);
  repaint(refs);
  if (pending.size) lookup();
}
/** Fetch these refs now (one call) and resolve when they're known; screens prefetch before drawing. */
export async function prefetch(refs, maxWait = 1500) {
  const missing = refs.filter((r) => !cards.has(r));
  if (!missing.length) return;
  missing.forEach(want);
  await Promise.race([new Promise((r) => setTimeout(r, maxWait)), new Promise((r) => waiters.push(r))]);
}
const waiters = [];
function repaint(refs) {
  const set = new Set(refs);
  for (const el of $$("[data-ref]")) if (!refs || set.has(el.dataset.ref)) paint(el, el.dataset.ref);
  if (!pending.size) waiters.splice(0).forEach((r) => r());
}

// ---------- the board store ----------

export const board = { data: null, at: 0, error: null, loading: null };
const boardListeners = new Set();
export const onBoard = (fn) => (boardListeners.add(fn), () => boardListeners.delete(fn));
const emit = () => boardListeners.forEach((fn) => fn());

export function loadBoard(force = false) {
  if (board.loading) return board.loading;
  if (!force && board.data && Date.now() - board.at < 55_000) return Promise.resolve(board.data);
  board.loading = get(`/board${force ? "?refresh=1" : ""}`)
    .then((d) => {
      board.data = d;
      board.at = Date.now();
      board.error = null;
      for (const col of d.columns) for (const c of col.cards) cards.set(c.ref, c);
      repaint();
      return d;
    })
    .catch((e) => {
      board.error = e;
      throw e;
    })
    .finally(() => {
      board.loading = null;
      emit();
    });
  emit();
  return board.loading;
}
export const allCards = () => board.data?.columns.flatMap((c) => c.cards) ?? [];

// Put a card in the column its status says (or "No status"), in place, without a refetch.
function place(card) {
  if (!board.data) return;
  for (const col of board.data.columns) col.cards = col.cards.filter((c) => c.ref !== card.ref);
  const col = board.data.columns.find((c) => c.label === card.column) ?? board.data.columns.find((c) => c.label === null);
  col?.cards.unshift(card);
}

/** Optimistic status move: the card moves now, rolls back on error, and the toast offers Undo. */
export async function setStatus(ref, status, { undo = true } = {}) {
  const before = cards.get(ref) ?? allCards().find((c) => c.ref === ref);
  if (!before || before.status === status) return;
  const isCol = state.ctx.columns.some((c) => c.label === status);
  const moved = { ...before, status, statusName: statusName(status), column: isCol ? status : null };
  cards.set(ref, moved);
  place(moved);
  emit();
  repaint([ref]);
  refreshPanel();
  try {
    const r = await post(`/issues/${ref.replace("#", "/")}/status`, { status });
    if (r.card) {
      cards.set(ref, r.card);
      place(r.card);
      emit();
      refreshPanel();
    }
    if (undo) toast(`Moved ${before.ident} to ${statusName(status)}`, before.status ? { label: "Undo", run: () => setStatus(ref, before.status, { undo: false }) } : undefined);
    else toast(`Moved ${before.ident} back to ${statusName(status)}`);
  } catch (e) {
    cards.set(ref, before);
    place(before);
    emit();
    repaint([ref]);
    refreshPanel();
    document.dispatchEvent(new CustomEvent("houston:error", { detail: `Couldn't move ${before.ident}: ${e.message}` }));
  }
}

export async function statusMenu(ref) {
  const c = cards.get(ref) ?? allCards().find((x) => x.ref === ref);
  if (!c) return;
  const opts = state.ctx.columns.map((col) => [col.label, col.name, statusIcon(col.label)]);
  const s = await pick(`Move ${c.ident} to…`, opts, c.status);
  if (s) setStatus(ref, s);
}

// ---------- the issue panel (docked right; overlays below 1100px) ----------

const panel = { ref: null, data: null, error: null };
export const panelRef = () => panel.ref;

export async function openIssue(ref, { force = false } = {}) {
  const box = $("#detail");
  const same = panel.ref === ref;
  panel.ref = ref;
  if (!same) {
    panel.data = null;
    panel.error = null;
    panel.restore = document.activeElement;
  }
  box.hidden = false;
  $("#detail-scrim").hidden = false;
  document.dispatchEvent(new CustomEvent("houston:panel", { detail: ref }));
  drawPanel();
  if (!same) $("#detail .d-bar [data-act='close-issue']")?.focus();
  try {
    const d = await get(`/issues/${ref.replace("#", "/")}?comments=1${force ? "&refresh=1" : ""}`);
    if (panel.ref !== ref) return;
    panel.data = d;
    cards.set(ref, { ...cards.get(ref), ...d });
    repaint([ref]);
  } catch (e) {
    if (panel.ref !== ref) return;
    panel.error = e;
  }
  drawPanel();
}
export function closeIssue() {
  if (!panel.ref) return false;
  panel.ref = null;
  $("#detail").hidden = true;
  $("#detail-scrim").hidden = true;
  $("#detail-body")._html = null;
  document.dispatchEvent(new CustomEvent("houston:panel", { detail: null }));
  if (panel.restore?.isConnected) panel.restore.focus();
  return true;
}
function refreshPanel() {
  if (panel.ref && panel.data) {
    const c = cards.get(panel.ref);
    if (c) Object.assign(panel.data, { status: c.status, statusName: c.statusName, column: c.column });
    drawPanel();
  }
}

function drawPanel() {
  const ref = panel.ref;
  if (!ref) return;
  const d = panel.data ?? cards.get(ref);
  const head = html`<div class="d-bar">
      <span class="ident" title="${ref}">${d?.ident ?? identOf(ref)}</span><span class="mute small">&nbsp;${ref.split("/")[0]}</span>
      <span class="spacer"></span>
      ${panel.data ? html`<span class="mute small" title="Fetched from GitHub">${ago(panel.data.fetchedAt)}</span>` : ""}
      <button class="icon-btn" data-act="refresh-issue" title="Fetch again" aria-label="Fetch again">${I.refresh}</button>
      <a class="icon-btn" href="${d?.url ?? `https://github.com/${ref.replace("#", "/issues/")}`}" target="_blank" rel="noreferrer" title="Open on GitHub (o)" aria-label="Open on GitHub">${I.external}</a>
      <button class="icon-btn" data-act="close-issue" title="Close (Esc)" aria-label="Close">${I.x}</button>
    </div>`;
  let body;
  if (!d && panel.error) body = errorNotice(panel.error, "refresh-issue");
  else if (!d) body = skeletonBlock(6);
  else {
    const parts = summaryParts(panel.data?.summary);
    body = html`
      ${panel.error ? errorNotice(panel.error, "refresh-issue") : ""}
      <h2 class="d-title" id="d-title">${d.title}</h2>
      <div class="props">
        <button class="btn sm outline" data-act="issue-status" title="Status (s)">${statusIcon(d.status ?? "none", d.state === "closed")}<span>${d.state === "closed" ? "Closed" : d.statusName ?? "No status"}</span></button>
        <span class="pill" title="Priority">${prioIcon(d.priority)}${d.priorityName ?? "No priority"}</span>
        ${d.assignees?.length ? d.assignees.map((a) => html`<span class="pill">${avatar(a, "sm")}${a}</span>`) : html`<span class="pill mute">${I.user}Unassigned</span>`}
        ${d.kind ? html`<span class="chip">${d.kind}</span>` : ""}
        ${(d.labels ?? []).map((l) => html`<span class="chip">${l}</span>`)}
      </div>
      ${
        panel.data
          ? html`${
              panel.data.summary
                ? html`<section class="summary-card" aria-label="Living summary"><header>${I.sparkle}Living summary</header>
                  <dl>${parts.map((p) => html`<dt>${p.label || "Summary"}</dt><dd><div class="md">${md(p.text)}</div></dd>`)}</dl></section>`
                : html`<p class="mute small">No living summary yet. Agents write one when they work on this issue.</p>`
            }
            <div class="d-section">Description</div>
            ${panel.data.body?.trim() ? html`<div class="md">${md(panel.data.body, { shift: 2 })}</div>` : html`<p class="mute">No description.</p>`}
            ${panel.data.comments?.length ? html`<div class="d-section">${panel.data.comments.length} comment${panel.data.comments.length === 1 ? "" : "s"}</div>
              ${panel.data.comments.map((c) => html`<article class="comment"><header>${c.author ? html`${avatar(c.author, "sm")}<b>${c.author}</b>` : "Comment"}${c.createdAt ? html` · ${ago(c.createdAt)}` : ""}</header><div class="md">${md(c.body)}</div></article>`)}` : ""}`
          : skeletonBlock(4)
      }`;
  }
  const el = $("#detail-body");
  const top = $(".d-scroll", el)?.scrollTop ?? 0;
  if (setHTML(el, html`${head}<div class="d-scroll">${body}</div>`)) $(".d-scroll", el).scrollTop = top;
}

document.addEventListener("click", (e) => {
  const chip = e.target.closest(".issue-ref[data-ref]");
  if (chip && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.target.closest("#overlay")) {
    e.preventDefault();
    openIssue(chip.dataset.ref);
    return;
  }
  const a = e.target.closest("#detail [data-act]");
  if (!a) return;
  if (a.dataset.act === "close-issue") closeIssue();
  else if (a.dataset.act === "refresh-issue") openIssue(panel.ref, { force: true });
  else if (a.dataset.act === "issue-status") statusMenu(panel.ref);
});
$("#detail-scrim")?.addEventListener("click", closeIssue);

// ---------- ⌘K issue picker (for the Notes editor and the palette) ----------

/** Search the board's issues; resolves the chosen ref or undefined. */
export function pickIssue(title = "Link an issue") {
  return new Promise((resolve) => {
    let hi = 0;
    let found = [];
    let chosen;
    openModal(
      html`<div class="scrim" data-close></div>
      <div class="menu picker" role="dialog" aria-modal="true" aria-label="${title}">
        <label class="input wide">${I.search}<input id="pick-q" placeholder="Search issues by title or number" autocomplete="off" aria-label="Search issues" aria-controls="pick-list"></label>
        <div id="pick-list" class="opt-list" role="listbox"></div>
      </div>`,
      {
        key(e) {
          if (e.key === "ArrowDown") hi = Math.min(found.length - 1, hi + 1);
          else if (e.key === "ArrowUp") hi = Math.max(0, hi - 1);
          else if (e.key === "Enter") return e.preventDefault(), choose(hi);
          else return;
          e.preventDefault();
          draw();
        },
        click(e) {
          const b = e.target.closest("[data-pick]");
          if (b) choose(Number(b.dataset.pick));
        },
        onClose: () => resolve(chosen),
      },
    );
    const choose = (n) => {
      chosen = found[n]?.ref;
      closeModal();
    };
    const draw = () => {
      const el = $("#pick-list");
      if (!el) return;
      const q = $("#pick-q").value.trim().toLowerCase();
      found = searchIssues(q).slice(0, 10);
      hi = Math.min(hi, Math.max(0, found.length - 1));
      setHTML(
        el,
        !board.data && board.loading
          ? html`<p class="mute pad">Loading issues…</p>`
          : found.length
            ? found.map((c, n) => html`<button class="opt ${n === hi ? "hi" : ""}" data-pick="${n}" role="option" aria-selected="${n === hi}">${statusIcon(c.status ?? "none")}<span class="ident">${c.ident}</span><span>${c.title}</span></button>`)
            : html`<p class="mute pad">${board.error ? board.error.message : "No issues match."}</p>`,
      );
    };
    $("#pick-q").oninput = () => ((hi = 0), draw());
    draw();
    loadBoard().then(draw, draw);
  });
}

/** Simple ranked search over open issues: ident/number match first, then title words. */
export function searchIssues(q) {
  const list = allCards();
  if (!q) return list.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const words = q.replace(/^#/, "").split(/\s+/);
  return list
    .map((c) => {
      const hay = `${c.ident} ${c.ref} #${c.number} ${c.title}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return null;
      const score = (c.ident.toLowerCase() === q || String(c.number) === q.replace(/^#/, "") ? 0 : c.title.toLowerCase().startsWith(q) ? 1 : 2);
      return [score, c];
    })
    .filter(Boolean)
    .sort((a, b) => a[0] - b[0] || b[1].updatedAt.localeCompare(a[1].updatedAt))
    .map((x) => x[1]);
}

