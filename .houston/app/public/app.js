// Houston's local app: hash-routed screens over the JSON API in server.ts.
// Vanilla ES module, no build step. Every string from files or GitHub is escaped before it
// reaches the DOM; the markdown renderer escapes first and only then adds its own tags.

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const main = $("#main");
const panel = $("#panel");
let ctx;
let dirty = false; // an unsaved textarea on the current screen

// ---------- HTML and markdown ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
class Raw {
  constructor(s) {
    this.s = s;
  }
  toString() {
    return this.s;
  }
}
const raw = (s) => new Raw(s);
const show = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(show).join("") : v === false || v == null ? "" : esc(v));
/** Tagged template: interpolated values are escaped unless they are already html`` or raw(). */
const html = (strings, ...vals) => raw(strings.reduce((out, s, i) => out + s + (i < vals.length ? show(vals[i]) : ""), ""));

const SAFE_URL = /^(https?:\/\/|mailto:|#)/;

function inline(s) {
  // Stash code spans and links so emphasis rules can't reach inside them.
  const stash = [];
  const keep = (h) => `\u0000${stash.push(h) - 1}\u0000`;
  s = s.replace(/`([^`]+)`/g, (_, c) => keep(`<code>${c}</code>`));
  s = s.replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, (m, text, href) => (SAFE_URL.test(href) ? keep(`<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`) : m));
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, href) => pre + keep(`<a href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>`));
  s = s.replace(/(^|[^\w./-])([\w.-]+\/[\w.-]+)#(\d+)\b/g, (_, pre, repo, n) => pre + keep(`<a href="https://github.com/${repo}/issues/${n}" target="_blank" rel="noopener noreferrer">${repo}#${n}</a>`));
  s = s
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w*])\*([^*\s][^*]*)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_([^_\s][^_]*)_(?!\w)/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[i]);
}

/** Headings, lists, checkboxes, bold/italic, inline code, code blocks, links. HTML in the source shows as text. */
function md(src) {
  let out = "";
  let list = null;
  let code = null;
  const close = () => {
    if (list) out += `</${list}>`;
    list = null;
  };
  for (const line of esc(src ?? "").split("\n")) {
    if (code !== null) {
      if (/^\s*```/.test(line)) {
        out += `<pre><code>${code}</code></pre>`;
        code = null;
      } else code += line + "\n";
      continue;
    }
    let m;
    if (/^\s*```/.test(line)) {
      close();
      code = "";
    } else if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      close();
      const n = Math.min(m[1].length + 2, 6); // page headings sit under the screen's own h1/h2
      out += `<h${n}>${inline(m[2])}</h${n}>`;
    } else if ((m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line))) {
      const tag = /\d/.test(m[1]) ? "ol" : "ul";
      if (list !== tag) {
        close();
        out += `<${tag}>`;
        list = tag;
      }
      const task = /^\[([ xX])\]\s*(.*)$/.exec(m[2]);
      out += task
        ? `<li class="task"><input type="checkbox" disabled${task[1] === " " ? "" : " checked"} aria-label="${task[1] === " " ? "not done" : "done"}"> ${inline(task[2])}</li>`
        : `<li>${inline(m[2])}</li>`;
    } else if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      close();
      out += "<hr>";
    } else if (/^&lt;!--.*--&gt;$/.test(line.trim())) {
      // houston markers in drafts and summaries: not content
    } else if (!line.trim()) close();
    else {
      close();
      out += `<p>${inline(line)}</p>`;
    }
  }
  if (code !== null) out += `<pre><code>${code}</code></pre>`;
  close();
  return raw(out);
}

// ---------- API, time, small UI pieces ----------

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: method === "GET" ? {} : { "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({ error: `The server answered ${res.status} with something that isn't JSON.` }));
  if (!res.ok) throw new Error(data.error ?? `The server answered ${res.status}.`);
  return data;
}

function ago(iso) {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
const day = (date) => new Date(`${date}T00:00:00`).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: "numeric" });

let toastTimer;
function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("on"), 3500);
}

const errorBox = (message) => html`<div class="error" role="alert">${message}</div>`;

/** Runs an action from a button: disables it, shows errors in `where` (or a toast on success). */
async function act(button, where, fn) {
  button.disabled = true;
  where.replaceChildren();
  try {
    return await fn();
  } catch (e) {
    where.innerHTML = errorBox(e.message);
  } finally {
    button.disabled = false;
  }
}

function render(content) {
  main.innerHTML = content;
}

/** ⌘S / Ctrl-S in a textarea clicks the save button next to it. */
function saveShortcut(textarea, button) {
  textarea.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      button.click();
    }
  });
  textarea.addEventListener("input", () => (dirty = true));
}

// ---------- header ----------

function header() {
  $("#team").textContent = ctx.team;
  $("#login").textContent = `@${ctx.user}`;
  const run = ctx.lastRun;
  const fresh = $("#fresh");
  const age = run ? Date.now() - Date.parse(run.at) : Infinity;
  const level = !run ? "none" : run.outcome === "failed" ? "bad" : age > 2 * ctx.runsEveryMs ? "stale" : "ok";
  fresh.className = `fresh ${level}`;
  fresh.innerHTML = html`<span class="dot" aria-hidden="true"></span>${run ? `Last run ${ago(run.at)}, ${run.outcome}` : "No run on this machine yet"}`;
  fresh.title = run ? `${new Date(run.at).toLocaleString()}${run.note ? ` · ${run.note}` : ""}` : "";
}

// ---------- Pages: a cadence period's Notes and everyone's Update ----------

const pageLink = (cadence, project, period) => `#/pages/${encodeURIComponent(cadence)}${project ? `/${encodeURIComponent(project)}` : ""}${period ? `/${period}` : ""}`;

/** Every cadence any project uses, once, for the nav. */
function allCadences() {
  const seen = new Map();
  for (const p of Object.values(ctx.projects)) for (const c of p.cadences) seen.set(c.name, c.title);
  return [...seen].map(([name, title]) => ({ name, title }));
}

async function pages([cadence, project, period]) {
  if (!allCadences().some((c) => c.name === cadence)) cadence = allCadences()[0]?.name;
  const projects = Object.keys(ctx.projects).filter((id) => ctx.projects[id].cadences.some((c) => c.name === cadence));
  if (!projects.length)
    return render(html`<h1>Pages</h1><p class="empty">No project has a cadence yet. Ask your agent in this repo to add one, for example "add a daily standup at 10:00".</p>`);
  if (!projects.includes(project)) project = projects.find((id) => ctx.mine.includes(id)) ?? projects[0];
  const data = await api(`/api/page/${encodeURIComponent(project)}/${encodeURIComponent(cadence)}${period ? `/${encodeURIComponent(period)}` : ""}`);
  render(html`
    ${periodBar(data, projects)}
    <div id="page-msg"></div>
    ${data.exists ? pageBody(data) : html`
      <div class="empty">
        <p>There's no page for this period yet.</p>
        ${data.period === data.current ? html`<button class="btn primary" id="create">Create the page</button>` : ""}
      </div>`}`);

  $("#project")?.addEventListener("change", (e) => (location.hash = pageLink(cadence, e.target.value)));
  for (const b of $$("[data-go]")) b.addEventListener("click", () => (location.hash = b.dataset.go));
  $("#create")?.addEventListener("click", (e) =>
    act(e.target, $("#page-msg"), async () => {
      await api(`/api/page/${encodeURIComponent(project)}/${encodeURIComponent(cadence)}`, { method: "POST" });
      route();
    }),
  );
  if (data.exists && !data.frozen) wireNotesEditor(data);
}

function periodBar(data, projects) {
  const link = (period) => pageLink(data.cadence.name, data.project, period);
  return html`
    <div class="bar">
      ${projects.length > 1
        ? html`<label class="field">Project <select id="project">${projects.map((id) => html`<option value="${id}" ${id === data.project ? "selected" : ""}>${ctx.projects[id].name}</option>`)}</select></label>`
        : html`<span class="project-name">${ctx.projects[data.project].name}</span>`}
    </div>
    <div class="period">
      <h1>${data.cadence.title} <span class="date">${day(data.period)}</span></h1>
      ${data.frozen ? html`<span class="badge frozen" title="The next period has started, so this page no longer changes">Frozen</span>` : ""}
      <div class="period-nav">
        ${data.prev ? html`<button class="btn" data-go="${link(data.prev)}" aria-label="Previous period, ${day(data.prev)}">‹ ${data.prev}</button>` : html`<button class="btn" disabled aria-label="No earlier period">‹</button>`}
        ${data.period === data.current ? "" : html`<a class="btn" href="${link(data.current)}">Current</a>`}
        ${data.next ? html`<button class="btn" data-go="${link(data.next)}" aria-label="Next period, ${day(data.next)}">${data.next} ›</button>` : html`<button class="btn" disabled aria-label="No later period">›</button>`}
      </div>
    </div>`;
}

function pageBody(data) {
  const notes = data.notes ?? "";
  return html`
    <section class="notes" aria-labelledby="notes-h">
      <div class="section-head">
        <h2 id="notes-h">Notes</h2>
        ${data.frozen ? "" : html`
          <div class="actions">
            <span class="hint" id="save-state"></span>
            <button class="btn" id="preview" aria-pressed="false">Preview</button>
            <button class="btn primary" id="save">Save notes</button>
          </div>`}
      </div>
      ${data.frozen
        ? html`<div class="md">${notes.trim() ? md(notes) : html`<p class="muted">Nobody wrote notes for this period.</p>`}</div>`
        : html`<label class="sr" for="notes-text">Notes for ${data.period}</label>
          <textarea id="notes-text" class="doc" spellcheck="true">${notes}</textarea>
          <div class="md" id="notes-preview" hidden></div>`}
    </section>
    <section aria-labelledby="updates-h">
      <h2 id="updates-h" class="section-title">Updates</h2>
      ${data.updates.map(updateBlock)}
    </section>`;
}

function updateBlock(u) {
  if (u.missing) return html`<article class="person missing"><h3>@${u.user}</h3><p class="muted">No update yet.</p></article>`;
  return html`
    <article class="person">
      <h3>@${u.user}</h3>
      <div class="md">${md(u.body)}</div>
      ${telemetry(u.footer)}
    </article>`;
}

/** The run footer as a strip: run time, each source's health, and "not reviewed". */
function telemetry(f) {
  if (!f) return html`<div class="telemetry"><span class="muted">No run footer</span></div>`;
  return html`<div class="telemetry ${f.problem ? "warn" : ""}">
    <span class="when">Run ${f.time}</span>
    ${Object.entries(f.sources).map(([name, health]) => html`<span class="src ${health === "ok" ? "ok" : "bad"}"><span class="dot" aria-hidden="true"></span>${name} ${health}</span>`)}
    ${f.notReviewed ? html`<span class="badge">Not reviewed</span>` : ""}
  </div>`;
}

function wireNotesEditor(data) {
  const text = $("#notes-text");
  const preview = $("#notes-preview");
  const toggle = $("#preview");
  const save = $("#save");
  const state = $("#save-state");
  let loaded = data.notesHash;
  saveShortcut(text, save);
  text.addEventListener("input", () => (state.textContent = "Unsaved changes"));
  toggle.addEventListener("click", () => {
    const on = preview.hidden;
    preview.innerHTML = md(text.value);
    preview.hidden = !on;
    text.hidden = on;
    toggle.setAttribute("aria-pressed", String(on));
    toggle.textContent = on ? "Edit" : "Preview";
  });
  save.addEventListener("click", () =>
    act(save, $("#page-msg"), async () => {
      const r = await api(`/api/page/${encodeURIComponent(data.project)}/${encodeURIComponent(data.cadence.name)}/${data.period}`, { method: "PUT", body: { text: text.value, hash: loaded } });
      loaded = r.notesHash;
      dirty = false;
      state.textContent = r.committed ? (r.pushed ? "Saved and pushed" : "Saved and committed") : "Saved, nothing changed";
      if (r.note && r.committed && !r.pushed) state.textContent += ` (${r.note})`;
    }),
  );
}

// ---------- Board and the issue panel ----------

const filter = { project: "", person: "" };

async function board(_, refresh = false) {
  const data = await api(`/api/board${refresh ? "?refresh=1" : ""}`);
  const keep = (c) => (!filter.project || c.project === filter.project) && (!filter.person || c.assignees.includes(filter.person));
  const projects = Object.entries(ctx.projects);

  render(html`
    <div class="bar">
      <h1>Board</h1>
      ${projects.length > 1 ? html`<label class="field">Project <select id="f-project"><option value="">All</option>${projects.map(([id, p]) => html`<option value="${id}" ${filter.project === id ? "selected" : ""}>${p.name}</option>`)}</select></label>` : ""}
      <label class="field">Person <select id="f-person"><option value="">Everyone</option>${ctx.members.map((m) => html`<option value="${m}" ${filter.person === m ? "selected" : ""}>@${m}</option>`)}</select></label>
      <span class="spacer"></span>
      <span class="hint">Fetched ${ago(data.fetchedAt)}</span>
      <button class="btn" id="refresh" title="Fetch issues from GitHub again (r)">Refresh</button>
    </div>
    <div id="board-msg">${data.errors.map((e) => errorBox(`Couldn't read ${e}`))}</div>
    <div class="board">
      ${data.columns.map((col) => {
        const cards = col.cards.filter(keep);
        return html`
          <section class="column" data-label="${col.label ?? ""}" aria-label="${col.name}">
            <h2>${col.name} <span class="count">${cards.length}</span></h2>
            <div class="cards">${cards.length ? cards.map(card) : html`<p class="muted small">Nothing here</p>`}</div>
          </section>`;
      })}
    </div>`);

  $("#f-project")?.addEventListener("change", (e) => ((filter.project = e.target.value), board()));
  $("#f-person").addEventListener("change", (e) => ((filter.person = e.target.value), board()));
  $("#refresh").addEventListener("click", () => board([], true));
  $$("[data-open]").forEach((b) => b.addEventListener("click", () => openIssue(b.dataset.open, b)));
  $$(".card select").forEach((s) => s.addEventListener("change", () => moveCard(s.dataset.ref, s.value, s)));

  // Drag and drop between columns; the select on each card does the same for keyboards.
  $$(".card").forEach((c) => c.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/plain", c.dataset.ref)));
  $$(".column").forEach((col) => {
    if (!col.dataset.label) return;
    col.addEventListener("dragover", (e) => (e.preventDefault(), col.classList.add("over")));
    col.addEventListener("dragleave", () => col.classList.remove("over"));
    col.addEventListener("drop", (e) => {
      e.preventDefault();
      col.classList.remove("over");
      const ref = e.dataTransfer.getData("text/plain");
      if (ref) moveCard(ref, col.dataset.label);
    });
  });
}

function card(c) {
  const priority = c.priority ? ctx.priority[c.priority] ?? c.priority : null;
  return html`
    <article class="card" draggable="true" data-ref="${c.ref}">
      <div class="card-top">
        <button class="ref" data-open="${c.ref}">${c.ref}</button>
        ${priority ? html`<span class="prio ${c.priority}" title="Priority ${c.priority}">${priority}</span>` : ""}
      </div>
      <button class="card-title" data-open="${c.ref}">${c.title}</button>
      <div class="card-meta">
        ${c.assignees.length ? c.assignees.map((a) => html`<span class="who">@${a}</span>`) : html`<span class="muted">Unassigned</span>`}
        ${c.hasSummary ? html`<span class="has-summary" title="Has a living summary">Summary</span>` : html`<span class="muted" title="No living summary yet">No summary</span>`}
        <select data-ref="${c.ref}" aria-label="Status of ${c.ref}">
          ${c.column ? "" : html`<option value="" selected disabled>${c.status ?? "No status"}</option>`}
          ${ctx.columns.map((col) => html`<option value="${col.label}" ${col.label === c.column ? "selected" : ""}>${col.name}</option>`)}
        </select>
      </div>
    </article>`;
}

async function moveCard(ref, status, control) {
  if (control) control.disabled = true;
  try {
    const [repo, number] = ref.split("#");
    await api(`/api/issues/${repo}/${number}/status`, { method: "POST", body: { status } });
    toast(`Moved ${ref} to ${ctx.columns.find((c) => c.label === status)?.name ?? status}`);
    await board([], true);
  } catch (e) {
    $("#board-msg").innerHTML = errorBox(e.message);
    if (control) control.disabled = false;
  }
}

let panelReturn;
async function openIssue(ref, from) {
  panelReturn = from;
  panel.hidden = false;
  panel.innerHTML = html`<p class="muted">Loading ${ref}…</p>`;
  try {
    const [repo, number] = ref.split("#");
    const i = await api(`/api/issues/${repo}/${number}`);
    panel.innerHTML = html`
      <div class="panel-head">
        <span class="ref">${i.ref}</span>
        <a class="btn" href="${i.url}" target="_blank" rel="noopener noreferrer">Open on GitHub</a>
        <button class="btn" id="close-panel" aria-label="Close (Escape)">Close</button>
      </div>
      <h2 id="panel-title">${i.title}</h2>
      <div class="labels">${i.labels.map((l) => html`<span class="label">${l}</span>`)}${i.assignees.map((a) => html`<span class="who">@${a}</span>`)}</div>
      <section class="summary" aria-label="Living summary">
        <h3>Living summary</h3>
        ${i.summary ? html`<div class="md">${md(i.summary)}</div>` : html`<p class="muted">No living summary yet. The next run of whoever works on it writes one.</p>`}
      </section>
      ${i.body ? html`<section aria-label="Issue description"><h3>Description</h3><div class="md">${md(i.body)}</div></section>` : ""}`;
  } catch (e) {
    panel.innerHTML = html`<div class="panel-head"><button class="btn" id="close-panel">Close</button></div>${errorBox(e.message)}`;
  }
  $("#close-panel").addEventListener("click", closePanel);
  $("#close-panel").focus();
}

function closePanel() {
  if (panel.hidden) return;
  panel.hidden = true;
  panelReturn?.focus();
}

// ---------- Review ----------

/** One intake PR's proposal, as `houston apply` would see it: its changes, or why apply would refuse it. */
function proposalView(p) {
  if (p.error) return errorBox(p.error);
  const notes = p.notes.map((n) => html`<details class="note" open><summary>${n.path}</summary><div class="md">${md(n.text)}</div></details>`);
  if (!p.proposalPath) return html`${notes}<p class="muted">This pull request has no proposal file, so merging it changes no issues.</p>`;
  if (p.refused) return html`${notes}<h3>Proposed changes <span class="muted small">${p.proposalPath}</span></h3><div class="warning" role="alert">Apply would refuse this: ${p.refused}</div>`;
  return html`
    ${notes}
    <h3>Proposed changes <span class="muted small">${p.proposalPath}</span></h3>
    ${p.changes.length ? html`<ul class="changes">${p.changes.map((c) => html`<li>${md(c)}</li>`)}</ul>` : html`<p class="muted">No issue changes proposed.</p>`}
    ${p.skipped.length ? html`<h3>Left out</h3><ul class="skipped">${p.skipped.map((s) => html`<li>${s}</li>`)}</ul>` : ""}`;
}

async function review(_, refresh = false) {
  if (!$("#review-h")) render(html`<h1 id="review-h">Review</h1><p class="muted">Reading intake pull requests…</p>`);
  const data = await api(`/api/review${refresh ? "?refresh=1" : ""}`);
  render(html`
    <div class="bar">
      <h1 id="review-h">Review</h1>
      <span class="spacer"></span>
      ${data.fetchedAt ? html`<span class="hint">Fetched ${ago(data.fetchedAt)}</span><button class="btn" id="refresh" title="Fetch intake pull requests again (r)">Refresh</button>` : ""}
    </div>
    <p class="lede">Intake turns a meeting or thread into notes and proposed issue changes, as one pull request in ${data.repo ?? "the Houston repo"}. To change or drop a proposed change, edit the pull request on GitHub; here you review it and merge it. Merging accepts it, and the owner's next run applies the changes (or run <code>houston apply</code>). Closing the pull request on GitHub discards it.</p>
    ${!data.repo
      ? html`<p class="empty">This Houston repo has no GitHub origin yet, so there are no intake pull requests to show.</p>`
      : !data.prs.length
        ? html`<p class="empty">Nothing waiting. New intake pull requests show up here.</p>`
        : data.prs.map(prView)}`);
  $("#refresh")?.addEventListener("click", () => review([], true));
  $$("[data-merge]").forEach((b) => b.addEventListener("click", () => mergePr(b)));
}

function prView(p) {
  return html`
    <article class="pr">
      <div class="section-head">
        <h2><a href="${p.url}" target="_blank" rel="noopener noreferrer">${p.title}</a></h2>
        <div class="actions">
          <a class="btn" href="${p.url}" target="_blank" rel="noopener noreferrer">Edit on GitHub</a>
          <button class="btn primary" data-merge="${p.number}">Merge</button>
        </div>
      </div>
      <p class="muted small">#${p.number} by @${p.author}, updated ${ago(p.updatedAt)}</p>
      <div class="msg" id="msg-${p.number}"></div>
      ${proposalView(p)}
    </article>`;
}

function mergePr(button) {
  const n = button.dataset.merge;
  if (!confirm(`Merge #${n}? The owner's next run applies its changes.`)) return;
  act(button, $(`#msg-${n}`), async () => {
    await api(`/api/review/${n}/merge`, { method: "POST" });
    toast(`Merged #${n}. The owner's next run applies it.`);
    review([], true);
  });
}

// ---------- My draft ----------

/** When the draft publishes, in the same words the run uses. */
function publishes(d) {
  if (d.held) return "Not while you hold it: it waits until you release it.";
  if (!d.deadline) return "When you approve it.";
  return d.edited
    ? `${d.deadline}, as you left it, unless you approve or hold it first.`
    : `${d.deadline}, marked "not reviewed", unless you approve, edit or hold it first.`;
}

async function draft() {
  const d = await api("/api/draft");
  if (!d.exists) return render(html`<h1>My draft</h1><p class="empty">No draft right now. Your next run writes one here for you to read, edit and approve.</p>`);
  render(html`
    <h1>My draft</h1>
    <dl class="facts">
      <div><dt>Created</dt><dd>${d.created}</dd></div>
      <div><dt>Covers</dt><dd>${d.window}</dd></div>
      <div><dt>Edited</dt><dd>${d.edited ? "Yes, by you" : "No"}</dd></div>
      <div><dt>Publishes</dt><dd>${publishes(d)}</dd></div>
    </dl>
    <label class="sr" for="draft-text">Draft</label>
    <textarea id="draft-text" class="doc tall" spellcheck="true">${d.text}</textarea>
    <div class="actions">
      <button class="btn" id="d-save">Save</button>
      <button class="btn primary" id="d-publish">Approve &amp; publish</button>
      <button class="btn" id="d-hold">${d.held ? "Release" : "Hold"}</button>
      <span class="spacer"></span>
      <button class="btn danger" id="d-discard">Discard</button>
    </div>
    <div id="draft-msg"></div>`);
  wireDraft(d);
}

function wireDraft(d) {
  const text = $("#draft-text");
  const msg = $("#draft-msg");
  const save = () => api("/api/draft", { method: "PUT", body: { text: text.value } }).then(() => (dirty = false));
  const run = (b, action, after) =>
    act(b, msg, async () => {
      if (dirty) await save();
      const r = await api(`/api/draft/${action}`, { method: "POST" });
      await draft();
      main.insertAdjacentHTML("beforeend", html`<pre class="output">${r.output || after}</pre>`.s);
    });
  saveShortcut(text, $("#d-save"));
  $("#d-save").addEventListener("click", (e) => act(e.target, msg, async () => (await save(), await draft(), toast("Draft saved"))));
  $("#d-publish").addEventListener("click", (e) => run(e.target, "publish", "Published."));
  $("#d-hold").addEventListener("click", (e) => run(e.target, d.held ? "release" : "hold", d.held ? "Released." : "Held."));
  $("#d-discard").addEventListener("click", (e) => {
    if (confirm("Throw this draft away? Its window is collected again on your next run.")) run(e.target, "discard", "Discarded.");
  });
}

// ---------- People ----------

async function peopleScreen() {
  const list = await api("/api/people");
  render(html`
    <h1>People</h1>
    <div class="people">
      ${list.map(
        (p) => html`
        <article class="person ${p.quiet ? "quiet" : ""}">
          <div class="section-head">
            <h2>@${p.user}${p.me ? html` <span class="muted small">(you)</span>` : ""}${p.lead ? html` <span class="badge">Lead</span>` : ""}</h2>
            ${p.quiet ? html`<span class="badge warn">No run data in the last day</span>` : ""}
          </div>
          ${p.run ? html`<div class="telemetry ${p.run.outcome === "failed" ? "warn" : ""}">
              <span class="when">Last run ${ago(p.run.at)}, ${p.run.outcome}</span>
              ${Object.entries(p.run.sources ?? {}).map(([k, v]) => html`<span class="src ${v === "ok" ? "ok" : "bad"}"><span class="dot" aria-hidden="true"></span>${k} ${v}</span>`)}
              ${p.run.note ? html`<span class="muted">${p.run.note}</span>` : ""}
            </div>` : ""}
          ${p.update ? html`<p class="muted small">Newest update: ${p.update.project} ${p.update.cadence} ${p.update.period}</p>${telemetry(p.update.footer)}` : ""}
          ${p.dayLog
            ? html`<details><summary>Day log ${day(p.dayLog.date)}</summary><div class="md clip">${md(p.dayLog.preview)}</div></details>`
            : html`<p class="muted">No day log yet.</p>`}
        </article>`,
      )}
    </div>`);
}

// ---------- Setup ----------

async function setup() {
  render(html`<h1>Setup</h1><p class="muted">Reading the setup…</p>`);
  const s = await api("/api/setup");
  render(html`
    <h1>Setup</h1>
    <p class="lede">To change how the team works, open your agent in this repo and say what you want (e.g. "move to two-week sprints").</p>
    <section><h2>How this team works</h2><pre class="output">${s.explain.output || "houston explain printed nothing."}</pre></section>
    <section>
      <h2>Checks ${s.validate.ok ? html`<span class="badge ok">All good</span>` : html`<span class="badge warn">Problems</span>`}</h2>
      <pre class="output">${s.validate.output || (s.validate.ok ? "houston.yml and cadences/ are valid." : "houston validate failed without saying why.")}</pre>
    </section>`);
}

// ---------- nav, routing and keys ----------

const screens = { pages, board, review, draft, people: peopleScreen, setup };

/** The Pages part of the nav: one link per cadence; then every nav link gets its number key. */
function buildNav() {
  const cadences = allCadences();
  $("#pages-nav").innerHTML = cadences.length
    ? html`${cadences.map((c) => html`<li><a href="${pageLink(c.name)}">${c.title}</a></li>`)}`
    : html`<li class="muted small">No cadences yet</li>`;
  $$(".rail a").forEach((a, i) => i < 9 && a.insertAdjacentHTML("beforeend", html` <kbd>${i + 1}</kbd>`.s));
}

/** The nav link for a hash: the one whose href is the hash or a parent of it. */
const navLinkFor = (hash) => $$(".rail a").find((a) => hash === a.getAttribute("href") || hash.startsWith(`${a.getAttribute("href")}/`));

let lastHash = location.hash;
async function route() {
  if (location.hash && !location.hash.startsWith("#/")) return; // in-page anchors like the skip link
  if (dirty && location.hash !== lastHash && !confirm("You have unsaved changes. Leave without saving?")) return history.replaceState(null, "", lastHash);
  if (!screens[location.hash.split("/")[1]]) history.replaceState(null, "", $(".rail a").getAttribute("href"));
  lastHash = location.hash;
  const [name, ...rest] = location.hash.replace(/^#\/?/, "").split("/");
  dirty = false;
  closePanel();
  const current = navLinkFor(location.hash);
  $$(".rail a").forEach((a) => (a === current ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  document.title = `${current ? current.firstChild.textContent.trim() : "Houston"} · Houston`;
  try {
    await screens[name](rest.map(decodeURIComponent));
  } catch (e) {
    render(errorBox(e.message));
  }
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") return closePanel();
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest("input, textarea, select, [contenteditable]")) return;
  const link = $$(".rail a")[Number(e.key) - 1];
  if (link) location.hash = link.getAttribute("href");
  if (e.key === "r" && location.hash.startsWith("#/board")) board([], true);
  if (e.key === "r" && location.hash.startsWith("#/review")) review([], true);
});

window.addEventListener("beforeunload", (e) => {
  if (dirty) e.preventDefault();
});
window.addEventListener("hashchange", route);

(async () => {
  try {
    ctx = await api("/api/context");
    header();
    buildNav();
  } catch (e) {
    return render(errorBox(e.message));
  }
  route();
})();
