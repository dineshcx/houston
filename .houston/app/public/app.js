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
const time = (iso) => (iso ? new Date(iso).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "");
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
  $("#login").textContent = ctx.user ? `@${ctx.user}` : "Not linked yet: run houston link";
  const run = ctx.lastRun;
  const fresh = $("#fresh");
  const age = run ? Date.now() - Date.parse(run.at) : Infinity;
  const level = !run ? "none" : run.outcome === "failed" ? "bad" : age > 2 * ctx.runsEveryMs ? "stale" : "ok";
  fresh.className = `fresh ${level}`;
  fresh.innerHTML = html`<span class="dot" aria-hidden="true"></span>${run ? `Last run ${ago(run.at)}, ${run.outcome}` : "No run on this machine yet"}`;
  fresh.title = run ? `${new Date(run.at).toLocaleString()}${run.note ? ` · ${run.note}` : ""}` : "";
}

// ---------- Today / Cadences ----------

async function today([project, cadence, period]) {
  const projects = Object.entries(ctx.projects).filter(([, p]) => p.cadences.length);
  if (!projects.length) return render(html`<h1>Today</h1><p class="empty">No project has a cadence yet. Ask your agent in this repo to add one, for example "add a daily standup at 10:00".</p>`);
  if (!ctx.projects[project]?.cadences.length) project = projects[0][0];
  const cadences = ctx.projects[project].cadences;
  if (!cadences.some((c) => c.name === cadence)) cadence = cadences[0].name;
  const data = await api(`/api/page/${encodeURIComponent(project)}/${encodeURIComponent(cadence)}${period ? `/${encodeURIComponent(period)}` : ""}`);
  const link = (p, c, d) => `#/today/${encodeURIComponent(p)}/${encodeURIComponent(c)}${d ? `/${d}` : ""}`;
  const isCurrent = data.period === data.current;

  render(html`
    <div class="bar">
      ${projects.length > 1
        ? html`<label class="field">Project <select id="project">${projects.map(([id, p]) => html`<option value="${id}" ${id === project ? "selected" : ""}>${p.name}</option>`)}</select></label>`
        : html`<span class="project-name">${ctx.projects[project].name}</span>`}
      <nav class="tabs" aria-label="Cadences">
        ${cadences.map((c) => html`<a href="${link(project, c.name)}" ${c.name === cadence ? raw('aria-current="page"') : ""}>${c.title}</a>`)}
      </nav>
    </div>
    <div class="period">
      <h1>${data.cadence.title} <span class="date">${day(data.period)}</span></h1>
      ${data.frozen ? html`<span class="badge frozen" title="The next period has started, so this page no longer changes">Frozen</span>` : ""}
      <div class="period-nav">
        ${data.prev ? html`<a class="btn" href="${link(project, cadence, data.prev)}" aria-label="Previous period">‹ ${data.prev}</a>` : html`<span class="btn" aria-disabled="true">‹</span>`}
        ${isCurrent ? "" : html`<a class="btn" href="${link(project, cadence, data.current)}">Current</a>`}
        ${data.next ? html`<a class="btn" href="${link(project, cadence, data.next)}" aria-label="Next period">${data.next} ›</a>` : html`<span class="btn" aria-disabled="true">›</span>`}
      </div>
    </div>
    <div id="page-msg"></div>
    ${data.exists ? pageBody(data) : html`
      <div class="empty">
        <p>There's no page for this period yet.</p>
        ${isCurrent ? html`<button class="btn primary" id="create">Create today's page</button>` : ""}
      </div>`}
  `);

  $("#project")?.addEventListener("change", (e) => (location.hash = link(e.target.value, "")));
  $("#create")?.addEventListener("click", (e) =>
    act(e.target, $("#page-msg"), async () => {
      await api(`/api/page/${encodeURIComponent(project)}/${encodeURIComponent(cadence)}`, { method: "POST" });
      route();
    }),
  );
  if (data.exists && !data.frozen) wirePageEditor(data);
}

function pageBody(data) {
  const notes = data.page ?? "";
  return html`
    <section class="notes" aria-labelledby="notes-h">
      <div class="section-head">
        <h2 id="notes-h">Team notes</h2>
        ${data.frozen ? "" : html`
          <div class="actions">
            <span class="hint" id="save-state"></span>
            <button class="btn" id="preview" aria-pressed="false">Preview</button>
            <button class="btn primary" id="save">Save</button>
          </div>`}
      </div>
      ${data.frozen
        ? html`<div class="md">${notes.trim() ? md(notes) : html`<p class="muted">Nobody wrote notes for this period.</p>`}</div>`
        : html`<label class="sr" for="page-text">Team notes for ${data.period}</label>
          <textarea id="page-text" class="doc" spellcheck="true">${notes}</textarea>
          <div class="md" id="page-preview" hidden></div>`}
    </section>
    <section aria-labelledby="people-h">
      <h2 id="people-h" class="section-title">Everyone's update</h2>
      ${data.people.map((p) => personBlock(p))}
    </section>`;
}

function personBlock(p) {
  if (p.missing)
    return html`<article class="person missing"><h3>@${p.user}</h3><p class="muted">No update yet.</p></article>`;
  return html`
    <article class="person">
      <h3>@${p.user}</h3>
      <div class="md">${md(p.body)}</div>
      ${telemetry(p)}
    </article>`;
}

/** The run footer as a strip: run time, each source's health, and "not reviewed". */
function telemetry(f) {
  if (!f?.footer) return html`<div class="telemetry"><span class="muted">No run footer</span></div>`;
  const parts = f.footer.replace(/^run\s*/, "").split(" · ");
  return html`<div class="telemetry ${f.sourceProblem ? "warn" : ""}">
    ${parts.map((part) => {
      if (part.startsWith("sources:"))
        return part
          .slice(8)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => html`<span class="src ${s.endsWith(" ok") ? "ok" : "bad"}"><span class="dot" aria-hidden="true"></span>${s}</span>`);
      if (part === "not reviewed") return html`<span class="badge">Not reviewed</span>`;
      return html`<span class="when">Run ${part}</span>`;
    })}
  </div>`;
}

function wirePageEditor(data) {
  const text = $("#page-text");
  const preview = $("#page-preview");
  const toggle = $("#preview");
  const save = $("#save");
  const state = $("#save-state");
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
      const r = await api(`/api/page/${encodeURIComponent(data.project)}/${encodeURIComponent(data.cadence.name)}/${data.period}`, { method: "PUT", body: { text: text.value } });
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
          ${c.status && ctx.columns.some((col) => col.label === c.status) ? "" : html`<option value="" selected disabled>${c.status ?? "No status"}</option>`}
          ${ctx.columns.map((col) => html`<option value="${col.label}" ${col.label === c.status ? "selected" : ""}>${col.name}</option>`)}
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

const VERBS = { create: "Create issue", update: "Update", comment: "Comment on", close: "Close" };

function change(c) {
  const [kind, fields] = Object.entries(c ?? {})[0] ?? ["?", {}];
  if (typeof fields !== "object" || fields === null) return html`<li><span class="verb">${VERBS[kind] ?? kind}</span> ${String(fields)}</li>`;
  const { repo, issue, title, body, ...rest } = fields;
  return html`<li>
    <span class="verb">${VERBS[kind] ?? kind}</span>
    ${issue ?? repo ? html`<span class="ref">${issue ?? repo}</span>` : ""}
    ${title ? html`<strong>${title}</strong>` : ""}
    ${body ? html`<span class="quote">${body}</span>` : ""}
    ${Object.entries(rest).map(([k, v]) => html`<span class="kv"><span class="k">${k.replace(/_/g, " ")}</span> ${typeof v === "object" ? JSON.stringify(v) : String(v)}</span>`)}
  </li>`;
}

function proposalView(p) {
  if (p.error) return errorBox(p.error);
  if (p.proposalError) return errorBox(p.proposalError);
  const changes = p.proposal?.changes ?? [];
  const skipped = p.proposal?.skipped ?? [];
  return html`
    ${p.notes.map((n) => html`<details class="note" open><summary>${n.path}</summary><div class="md">${md(n.text)}</div></details>`)}
    <h3>Proposed changes ${p.proposalPath ? html`<span class="muted small">${p.proposalPath}</span>` : ""}</h3>
    ${changes.length ? html`<ul class="changes">${changes.map(change)}</ul>` : html`<p class="muted">No issue changes proposed.</p>`}
    ${skipped.length
      ? html`<h3>Skipped</h3><ul class="skipped">${skipped.map((s) => html`<li>${typeof s === "object" ? Object.entries(s).map(([k, v]) => `${k}: ${v}`).join("; ") : s}</li>`)}</ul>`
      : ""}`;
}

async function review() {
  render(html`<h1>Review</h1><p class="muted">Reading intake pull requests…</p>`);
  const data = await api("/api/review");
  render(html`
    <h1>Review</h1>
    <p class="lede">Intake turns a meeting or thread into notes and proposed issue changes, as one pull request in ${data.repo ?? "the Houston repo"}. Merging accepts it; the owner's next run applies the changes (or run <code>houston apply</code>). To drop a change, edit the PR on GitHub first. Closing the PR discards it.</p>
    ${!data.repo
      ? html`<p class="empty">This Houston repo has no GitHub origin yet, so there are no intake pull requests to show.</p>`
      : !data.prs.length
        ? html`<p class="empty">Nothing waiting. New intake pull requests show up here.</p>`
        : data.prs.map(
            (p) => html`
          <article class="pr">
            <div class="section-head">
              <h2><a href="${p.url}" target="_blank" rel="noopener noreferrer">${p.title}</a></h2>
              <div class="actions">
                <a class="btn" href="${p.url}" target="_blank" rel="noopener noreferrer">Open on GitHub</a>
                <button class="btn primary" data-merge="${p.number}">Merge</button>
              </div>
            </div>
            <p class="muted small">#${p.number} by @${p.author}, updated ${ago(p.updatedAt)}</p>
            <div class="msg" id="msg-${p.number}"></div>
            ${proposalView(p)}
          </article>`,
          )}`);
  $$("[data-merge]").forEach((b) =>
    b.addEventListener("click", () => {
      if (!confirm(`Merge #${b.dataset.merge}? The owner's next run applies its changes.`)) return;
      act(b, $(`#msg-${b.dataset.merge}`), async () => {
        await api(`/api/review/${b.dataset.merge}/merge`, { method: "POST" });
        toast(`Merged #${b.dataset.merge}. The owner's next run applies it.`);
        review();
      });
    }),
  );
}

// ---------- My draft ----------

async function draft() {
  const d = await api("/api/draft");
  if (!d.exists)
    return render(html`<h1>My draft</h1><p class="empty">No draft right now. Your next run writes one here for you to read, edit and approve.</p>`);
  const s = d.draft;
  render(html`
    <h1>My draft</h1>
    <dl class="facts">
      ${s ? html`
        <div><dt>Created</dt><dd>${time(s.created)}</dd></div>
        <div><dt>Covers</dt><dd>${time(s.window_start)} to ${time(s.window_end)}</dd></div>
        <div><dt>Publishes</dt><dd>${s.held ? "Held until you release it" : s.deadline ? `${time(s.deadline)} unless you approve or hold it` : "When you approve it"}</dd></div>` : ""}
      <div><dt>Edited</dt><dd>${d.edited ? "Yes, by you" : "No"}</dd></div>
    </dl>
    <label class="sr" for="draft-text">Draft</label>
    <textarea id="draft-text" class="doc tall" spellcheck="true">${d.text}</textarea>
    <div class="actions">
      <button class="btn" id="d-save">Save</button>
      <button class="btn primary" id="d-publish">Approve &amp; publish</button>
      <button class="btn" id="d-hold">${s?.held ? "Release" : "Hold"}</button>
      <span class="spacer"></span>
      <button class="btn danger" id="d-discard">Discard</button>
    </div>
    <div id="draft-msg"></div>`);

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
  $("#d-save").addEventListener("click", (e) => act(e.target, msg, async () => (await save(), toast("Draft saved"))));
  $("#d-publish").addEventListener("click", (e) => run(e.target, "publish", "Published."));
  $("#d-hold").addEventListener("click", (e) => run(e.target, s?.held ? "release" : "hold", s?.held ? "Released." : "Held."));
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
          ${p.section ? html`<p class="muted small">Newest page section: ${p.section.project} ${p.section.cadence} ${p.section.period}</p>${telemetry(p.section)}` : ""}
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

// ---------- routing and keys ----------

const screens = { today, board, review, draft, people: peopleScreen, setup };
const ORDER = ["today", "board", "review", "draft", "people", "setup"];

let lastHash = location.hash;
async function route() {
  if (location.hash && !location.hash.startsWith("#/")) return; // in-page anchors like the skip link
  if (dirty && location.hash !== lastHash && !confirm("You have unsaved changes. Leave without saving?")) return history.replaceState(null, "", lastHash);
  lastHash = location.hash;
  const [name, ...rest] = location.hash.replace(/^#\/?/, "").split("/");
  const screen = screens[name] ? name : "today";
  dirty = false;
  closePanel();
  $$(".rail a").forEach((a) => (a.dataset.screen === screen ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  document.title = `${$(`.rail a[data-screen="${screen}"]`).textContent.replace(/\d/, "").trim()} · Houston`;
  try {
    await screens[screen](rest.map(decodeURIComponent));
  } catch (e) {
    render(errorBox(e.message));
  }
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") return closePanel();
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest("input, textarea, select, [contenteditable]")) return;
  const n = Number(e.key);
  if (n >= 1 && n <= ORDER.length) location.hash = `#/${ORDER[n - 1]}`;
  if (e.key === "r" && location.hash.startsWith("#/board")) board([], true);
});

window.addEventListener("beforeunload", (e) => {
  if (dirty) e.preventDefault();
});
window.addEventListener("hashchange", route);

(async () => {
  try {
    ctx = await api("/api/context");
    header();
  } catch (e) {
    return render(errorBox(e.message));
  }
  route();
})();
