// My draft (#/draft): a review screen, not a text box. The draft's sections grouped by where they go
// (standup updates, issue summaries, issue changes, day log), rendered as they'll appear, each
// editable on its own; the deadline countdown; Approve (⌘↵), Hold (h), Discard behind a menu + dialog.
import { get, put, post, del, state, cached } from "../api.js";
import { $, $$, html, setHTML, I, bar, countdown, notice, errorNotice, copyCmd, time, dayTime, ago, plural, shortDay, skeletonBlock, toast, busy, pick, confirmDialog, statusIcon, prioIcon } from "../ui.js";
import { chipHTML, prefetch } from "../issues.js";
import { md, refsIn, summaryParts } from "../markdown.js";
import { refreshSidebar } from "../app.js";

const GROUPS = [
  ["page", "Standup updates", "Published to the page for each meeting, exactly as shown."],
  ["summary", "Issue summaries", "Replace the living summary at the top of each issue."],
  ["changes", "Issue changes", "Labels and comments on GitHub issues."],
  ["day", "Day log", "Your private-ish log of the day, kept in the team's repo."],
];

export function mount(main, route) {
  const s = { data: cached("/draft") ?? null, error: null, editing: null, editState: "", raw: false, published: null, compare: new Set(), sel: -1, timer: null, route };

  async function load() {
    try {
      const d = await get("/draft");
      if (d.exists) await prefetch(d.sections.flatMap((x) => [x.target, ...refsIn(x.body)]).filter((r) => r.includes("#")), 1200);
      if (s.editing == null && !s.raw) s.data = d;
      else if (d.hash !== s.data?.hash && !s.timer) s.data = d;
      s.error = null;
    } catch (e) {
      if (e.down) return;
      s.error = e;
    }
    draw();
    // Deep links from the palette: #/draft?approve=1, #/draft?hold=1
    const p = s.route.params;
    s.route = { ...s.route, params: {} };
    if (p.approve && s.data?.exists) approve($("[data-act=approve]", main));
    if (p.hold && s.data?.exists) holdToggle($("[data-act=hold]", main));
  }

  // ---------- actions ----------

  const fail = (what, e) => document.dispatchEvent(new CustomEvent("houston:error", { detail: `${what}: ${e.message}` }));
  async function approve(btn) {
    if (!s.data?.exists || !btn || btn.disabled) return;
    await flushEdit();
    await busy(btn, "Publishing…", async () => {
      try {
        const r = await post("/draft/publish");
        s.published = r.published ?? { at: new Date().toISOString(), pages: [] };
        s.data = { exists: false };
        s.editing = null;
        toast(s.published.pages.length ? `Published to ${s.published.pages.map(pageName).join(", ")}` : "Published");
      } catch (e) {
        fail("Couldn't publish", e);
      }
    });
    draw();
    refreshSidebar();
  }
  async function holdToggle(btn) {
    if (!s.data?.exists || !btn) return;
    const action = s.data.held ? "release" : "hold";
    await busy(btn, action === "hold" ? "Holding…" : "Releasing…", async () => {
      try {
        const r = await post(`/draft/${action}`);
        s.data = r;
        toast(action === "hold" ? "Held. It won't publish until you release it." : "Released. It publishes at its deadline.");
      } catch (e) {
        fail(`Couldn't ${action} the draft`, e);
      }
    });
    draw();
    refreshSidebar();
  }
  async function more() {
    const v = await pick("Draft", [
      ["raw", "Edit raw file", I.pencil],
      ["discard", "Discard draft…", I.trash, { danger: true }],
    ]);
    if (v === "raw") return ((s.raw = true), (s.editing = null), draw(), $("#raw", main)?.focus());
    if (v !== "discard") return;
    const ok = await confirmDialog({
      title: "Throw this draft away?",
      body: html`<p>${s.data.summary}.</p><p>Nothing is published. Your next run collects the same time again and writes a new draft.</p>`,
      confirm: "Discard draft",
      danger: true,
    });
    if (!ok) return;
    try {
      await post("/draft/discard");
      s.data = { exists: false };
      toast("Draft discarded");
    } catch (e) {
      fail("Couldn't discard the draft", e);
    }
    draw();
    refreshSidebar();
  }
  async function remove(index) {
    const sec = s.data.sections[index];
    const before = s.data.text;
    try {
      const r = await del(`/draft/sections/${index}`, { hash: s.data.hash });
      s.data = r;
      toast(`Removed: ${sec.label}`, {
        label: "Undo",
        run: async () => {
          try {
            s.data = await put("/draft", { text: before, hash: s.data.hash });
            toast("Restored");
          } catch (e) {
            fail("Couldn't restore it", e);
          }
          draw();
        },
      });
    } catch (e) {
      fail("Couldn't remove it", e);
    }
    draw();
  }

  // Per-section edit: a plain textarea of just that section, saved 800 ms after you stop typing.
  function startEdit(index) {
    s.editing = index;
    s.editState = "";
    draw();
    const ta = $(`#edit-${index}`, main);
    ta?.focus();
    ta?.setSelectionRange(ta.value.length, ta.value.length);
  }
  async function flushEdit() {
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
      await saveEdit();
    }
  }
  async function saveEdit() {
    s.timer = null;
    const i = s.editing;
    const ta = $(`#edit-${i}`, main);
    if (i == null || !ta) return;
    const sec = s.data.sections.find((x) => x.index === i);
    if (ta.value.trim() === sec.body.trim()) return setEditState("");
    setEditState("Saving…");
    try {
      s.data = await put(`/draft/sections/${i}`, { body: ta.value, hash: s.data.hash, kind: sec.kind, target: sec.target });
      setEditState("Saved · later runs won't replace your edited draft");
    } catch (e) {
      setEditState(`Not saved: ${e.message}`, true);
    }
  }
  const setEditState = (t, bad) => {
    s.editState = t;
    const el = $("#edit-state", main);
    if (el) (el.textContent = t), el.classList.toggle("err", !!bad);
  };
  async function stopEdit() {
    await flushEdit();
    const i = s.editing;
    s.editing = null;
    draw();
    $(`[data-sec="${i}"]`, main)?.focus();
  }
  async function saveRaw(btn) {
    const ta = $("#raw", main);
    await busy(btn, "Saving…", async () => {
      try {
        s.data = await put("/draft", { text: ta.value, hash: s.data.hash });
        s.raw = false;
        toast("Draft saved");
      } catch (e) {
        fail("Couldn't save the draft", e);
      }
    });
    draw();
  }

  // ---------- drawing ----------

  function draw() {
    const d = s.data;
    const ex = d?.exists;
    const right = ex
      ? html`${countdown(d, "lg")}
        <button class="btn outline" data-act="hold" data-write title="${d.held ? "Release" : "Hold"} (h)">${d.held ? I.play : I.pause}${d.held ? "Release" : "Hold"}</button>
        <button class="btn primary" data-act="approve" data-write title="Approve & publish (⌘↵)">${I.send}Approve & publish <kbd>⌘↵</kbd></button>
        <button class="icon-btn" data-act="more" aria-label="More: edit raw file, discard" title="More">${I.more}</button>`
      : "";
    const scroll = $("#content", main)?.scrollTop ?? 0;
    setHTML(main, html`${bar("My draft", right)}<div class="content" id="content"><div class="column narrow">${s.error ? errorNotice(s.error) : ""}${content()}</div></div>`);
    $("#content", main).scrollTop = scroll;
  }

  function content() {
    const d = s.data;
    if (s.published) {
      const p = s.published;
      const next = state.ctx.lastRun && state.ctx.runsEveryMs ? new Date(Date.now() + state.ctx.runsEveryMs).toISOString() : null;
      return html`<section class="success" role="status"><h2>${I.checkCircle}Published ${time(p.at)}</h2>
        ${p.pages.length ? html`<p>Your update is on:</p><div class="ref-list">${p.pages.map((x) => html`<a class="btn sm outline" href="#/p/${x.project}/${x.cadence}/${x.period}">${I.page}${pageName(x)}</a>`)}</div>` : html`<p class="mute">Issue summaries and label changes went to GitHub.</p>`}
        <p class="mute">${next ? `Your next run is about ${time(next)}; it writes a new draft if there's something new.` : "Your next run writes a new draft if there's something new."}</p>
        <a class="btn ghost sm" href="#/today">Back to Today</a></section>`;
    }
    if (!d) return skeletonBlock(9);
    if (!d.exists) {
      const run = state.ctx.lastRun;
      const next = run && state.ctx.runsEveryMs ? new Date(Date.parse(run.at) + state.ctx.runsEveryMs).toISOString() : null;
      return html`<div class="empty">${I.inbox}<h2>No draft right now</h2>
        <p>${next ? `Your next run, about ${time(next)}, writes one here if there's something new.` : "Your run writes one here when it finds something new."} You review it, then it publishes to your team's pages.</p>
        <p class="small">${run ? `Last run ${ago(run.at)}: ${run.outcome}${run.note ? ` (${run.note})` : ""}.` : "No run on this laptop yet."} Run one now: ${copyCmd("houston run")}</p></div>`;
    }
    if (s.raw)
      return html`<div class="raw-edit">${notice("info", html`<b>Editing the raw file.</b> Keep the <code>&lt;!-- houston:… --&gt;</code> marker lines: they say where each part goes. ${"⌘S"} saves.`)}
        <textarea id="raw" aria-label="Raw draft file" spellcheck="false">${d.text}</textarea>
        <div class="row-actions"><button class="btn primary" data-act="save-raw" data-write>Save</button><button class="btn ghost" data-act="cancel-raw">Cancel</button></div></div>`;
    const by = (k) => d.sections.filter((x) => (k === "changes" ? x.kind === "labels" || x.kind === "comment" : x.kind === k));
    return html`
      ${d.held ? notice("held", html`<b>Held.</b> It won't publish until you release it, even past its deadline.`, html`<button class="btn sm outline" data-act="hold" data-write>${I.play}Release</button>`) : ""}
      ${d.overdue ? notice("", html`<b>Overdue.</b> The deadline passed while this laptop was asleep; it publishes at your next run unless you approve or hold it.`) : ""}
      ${d.failedSources.length ? notice("", html`<b>${d.failedSources.map((f) => f.name).join(", ")} couldn't be read</b> on this run, so the draft may be missing work. ${d.failedSources.map((f) => `${f.name}: ${f.why}`).join(" · ")}`) : ""}
      ${d.edited ? notice("info", html`<b>Edited by you.</b> Later runs won't replace it.`) : ""}
      <div class="facts">
        <span>${I.clock}Covers ${dayTime(d.windowStart)} → ${dayTime(d.windowEnd)}</span>
        <span class="src">Sources: ${Object.entries(d.sources).map(([k, v], n) => html`${n ? ", " : ""}<span class="${v === "ok" ? "" : "err"}">${k} ${v === "ok" ? "ok" : "failed"}</span>`)}</span>
        <span>Created ${time(d.createdAt)}</span>
      </div>
      <p class="lede">${d.summary}. ${d.mode === "review" ? "It waits for you: nothing publishes until you approve it." : d.publishesAt ? html`If you do nothing it publishes at ${time(d.publishesAt)}, marked “not reviewed”.` : ""}</p>
      ${GROUPS.map(([k, title, lede]) => {
        const list = by(k);
        if (!list.length) return "";
        return html`<h3 class="section-title">${title} <span class="count">${list.length}</span></h3><p class="lede small">${lede}</p>${list.map(section)}`;
      })}
      <p class="mute small">Something the cards can't express? <button class="btn xs ghost" data-act="raw">${I.pencil}Edit raw file</button></p>`;
  }

  function section(x) {
    const editing = s.editing === x.index;
    const sel = s.sel === s.data.sections.indexOf(x);
    const icon = { page: I.page, day: I.calendar, summary: I.sparkle, labels: I.tag, comment: I.message }[x.kind];
    const title =
      x.kind === "page" && x.destination
        ? html`<a class="t" href="#/p/${x.destination.project}/${x.destination.cadence}/${x.destination.period}">${x.destination.projectName} · ${x.destination.cadenceTitle} · ${shortDay(x.destination.period)}</a>`
        : x.kind === "day"
          ? html`<span class="t">Day log for ${shortDay(x.target)} <span class="mute">· ${plural(x.lines, "line")}</span></span>`
          : html`<span class="t">${x.kind === "summary" ? "Living summary" : x.kind === "comment" ? "Comment on" : "Changes to"}</span>${chipHTML(x.target, "wide")}`;
    const acts = html`
      ${x.kind === "summary" && x.currentSummary ? html`<button class="btn xs ghost" data-act="compare" data-i="${x.index}" aria-pressed="${s.compare.has(x.index)}">${s.compare.has(x.index) ? "Show new" : "Compare"}</button>` : ""}
      ${editing ? html`<button class="btn xs outline" data-act="done-edit">Done</button>` : html`<button class="btn xs ghost" data-act="edit" data-i="${x.index}" title="Edit this section (e)">${I.pencil}Edit</button>`}
      <button class="icon-btn" data-act="remove" data-i="${x.index}" title="Remove this section" aria-label="Remove ${x.label}">${I.trash}</button>`;
    let body;
    if (editing)
      body = html`<textarea id="edit-${x.index}" data-edit="${x.index}" aria-label="Edit ${x.label}" spellcheck="true">${x.body}</textarea>
        <div class="edit-foot"><span id="edit-state" role="status">${s.editState}</span><span class="spacer"></span><span>Saves as you type · Esc to finish</span></div>`;
    else if (x.kind === "labels") body = changesHTML(x);
    else if (x.kind === "summary") body = s.compare.has(x.index) ? diffHTML(x.currentSummary, x.body) : summaryHTML(x.body);
    else body = html`<div class="md">${md(x.body, { shift: 1 })}</div>`;
    const inner = html`${x.problem ? notice("err", html`<b>Publish would refuse this:</b> ${x.problem}`) : ""}${body}`;
    if (x.kind === "day" && !editing)
      return html`<article class="d-card ${sel ? "sel" : ""}" data-sec="${x.index}" tabindex="-1"><details><summary><header>${icon}${title}<span class="spacer"></span><span class="mute small">Show</span></header></summary><div class="body">${inner}</div></details></article>`;
    return html`<article class="d-card ${sel ? "sel" : ""}" data-sec="${x.index}" tabindex="-1" aria-label="${x.label}"><header>${icon}${title}<span class="spacer"></span>${acts}</header><div class="body">${inner}</div></article>`;
  }

  main.onclick = (e) => {
    const a = e.target.closest("[data-act]");
    if (!a || a.closest("#side")) return;
    const i = Number(a.dataset.i);
    const run = {
      approve: () => approve(a),
      hold: () => holdToggle(a),
      more,
      raw: () => ((s.raw = true), draw()),
      "cancel-raw": () => ((s.raw = false), draw()),
      "save-raw": () => saveRaw(a),
      edit: () => startEdit(i),
      "done-edit": stopEdit,
      remove: () => remove(i),
      compare: () => (s.compare.has(i) ? s.compare.delete(i) : s.compare.add(i), draw()),
    }[a.dataset.act];
    if (run) e.preventDefault(), run();
  };
  main.oninput = (e) => {
    if (!e.target.matches("[data-edit]")) return;
    setEditState("Editing…");
    clearTimeout(s.timer);
    s.timer = setTimeout(saveEdit, 800);
  };

  load();
  draw();
  return {
    poll: 30,
    help: [["⌘ ↵", "Approve & publish"], ["h", "Hold / release"], ["j k", "Next / previous section"], ["e", "Edit the selected section"], ["Esc", "Stop editing"], ["⌘ S", "Save the raw file"]],
    refresh: (force) => (force || (s.editing == null && !s.raw)) && load(),
    update: (r) => ((s.route = r), load()),
    async leave() {
      await flushEdit();
      main.onclick = main.oninput = null;
    },
    key(e, typing) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "Enter") {
        e.preventDefault();
        approve($("[data-act=approve]", main));
        return true;
      }
      if (typing) {
        if (e.key === "Escape" && e.target.matches("[data-edit]")) return e.preventDefault(), stopEdit(), true;
        if (mod && e.key.toLowerCase() === "s" && e.target.id === "raw") return e.preventDefault(), saveRaw($("[data-act=save-raw]", main)), true;
        return false;
      }
      if (mod || e.altKey || !s.data?.exists) return false;
      const n = s.data.sections.length;
      const run = {
        h: () => holdToggle($("[data-act=hold]", main)),
        j: () => moveSel(1),
        k: () => moveSel(-1),
        e: () => startEdit(s.data.sections[s.sel]?.index),
      }[e.key];
      if (!run || !n) return false;
      e.preventDefault();
      run();
      return true;
    },
  };
  function moveSel(d) {
    s.sel = Math.max(0, Math.min(s.data.sections.length - 1, s.sel + d));
    draw();
    const el = $(`.d-card.sel`, main);
    el?.scrollIntoView({ block: "nearest" });
    el?.focus({ preventScroll: true });
  }
}

const pageName = (x) => {
  const p = state.ctx.projects[x.project];
  return `${p?.name ?? x.project} · ${p?.cadences.find((c) => c.name === x.cadence)?.title ?? x.cadence} · ${shortDay(x.period)}`;
};
const statusPill = (label, name) => html`<span class="pill">${statusIcon(label ?? "none")}${name ?? "No status"}</span>`;
function changesHTML(x) {
  if (!x.changes?.length) return html`<div class="md">${md(x.body)}</div>`;
  return html`${x.changes.map((c) => {
    const pillFor = (v, name) =>
      v == null
        ? html`<span class="pill mute">none</span>`
        : c.field === "status"
          ? statusPill(v, name)
          : c.field === "priority"
            ? html`<span class="pill">${prioIcon(v)}${name ?? v}</span>`
            : html`<span class="chip">${name ?? v}</span>`;
    return html`<div class="change-row"><span class="field">${{ status: "Status", priority: "Priority", kind: "Kind", label: "Label" }[c.field]}</span>
      ${c.field === "label" ? (c.to == null ? html`remove ${pillFor(c.from, c.fromName)}` : html`add ${pillFor(c.to, c.toName)}`) : html`${pillFor(c.from, c.fromName)}<span class="arrow">→</span>${pillFor(c.to, c.toName)}`}</div>`;
  })}`;
}

function summaryHTML(text) {
  const parts = summaryParts(text);
  return html`<div class="summary-card"><dl>${parts.map((p) => html`<dt>${p.label || "Summary"}</dt><dd><div class="md">${md(p.text)}</div></dd>`)}</dl></div>`;
}

/** Line diff (LCS) of the issue's summary today vs. the draft's: removed lines struck, added lines green. */
function diffHTML(a, b) {
  const A = String(a ?? "").split("\n").filter((l) => l.trim());
  const B = String(b ?? "").split("\n").filter((l) => l.trim());
  const L = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) out.push(["same", A[i++]]), j++;
    else if (j < B.length && (i >= A.length || L[i][j + 1] >= L[i + 1][j])) out.push(["add", B[j++]]);
    else out.push(["del", A[i++]]);
  }
  return html`<div class="diff" aria-label="Changes to the living summary">${out.map(([k, l]) => html`<div class="${k}"><span class="sr-only">${{ add: "added: ", del: "removed: ", same: "" }[k]}</span>${l.replace(/\*\*/g, "")}</div>`)}</div>`;
}
