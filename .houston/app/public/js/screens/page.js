// A page (#/p/<project>/<cadence>[/<period>]): the period list, the Notes document (rich editor, saved
// as you type, synced to GitHub by the server) and, beside it, everyone's Updates with a Blocked
// roll-up on top and each update's run health shown before its content. Frozen periods are read-only.
import { get, put, post, state, cached, forget } from "../api.js";
import { $, $$, html, raw, setHTML, I, bar, avatar, notice, errorNotice, time, rel, ago, plural, longDay, shortDay, skeletonBlock, toast, busy, copy, codeText } from "../ui.js";
import { prefetch, chipHTML } from "../issues.js";
import { md, refsIn } from "../markdown.js";
import { mountNotes } from "../editor-host.js";

const FILTERS = [["all", "All"], ["blocked", "Blocked"], ["problems", "Problems"]];

export function mount(main, route) {
  const s = {
    key: null, // "project/cadence/period" the screen shows (period null = current)
    data: null,
    error: null,
    ed: null, // the mounted editor handle
    edKey: null,
    hash: null,
    notesText: null, // the Notes as last loaded or saved (to tell a teammate's change from ours)
    dirty: false,
    timer: null,
    syncTimer: null,
    save: { cls: "", text: "" },
    conflict: null,
    filter: localStorage.updatesFilter || "all",
    sel: -1,
    seen: null, // update signatures already shown (for the "new update" pill)
    pill: 0,
    showUpdates: false,
  };

  // ---------- loading ----------

  async function open(r) {
    await flush();
    const [project, cadence, period] = r.parts;
    s.key = `${project}/${cadence}${period ? `/${period}` : ""}`;
    // A period seen before draws at once from the last answer, then refreshes (no skeleton flash).
    s.data = cached(`/page/${s.key}`) ?? null;
    s.hash = s.data?.notesHash ?? null;
    s.notesText = s.data?.notes ?? null;
    s.error = null;
    s.conflict = null;
    s.seen = null;
    s.pill = 0;
    s.sel = -1;
    setSave("", "");
    unmountEditor();
    frame();
    if (s.data) draw();
    await load(true);
  }
  async function load(first) {
    const key = s.key;
    try {
      const d = await get(`/page/${key}`);
      if (key !== s.key) return;
      if (first) await prefetch([...refsIn(d.notes), ...d.updates.flatMap((u) => u.refs ?? []), ...d.blocked.flatMap((b) => b.refs)], 1200);
      if (key !== s.key) return;
      const before = s.data;
      s.data = d;
      s.error = null;
      if (!before) {
        s.hash = d.notesHash;
        s.notesText = d.notes;
        if (d.notesUnpushed) setSave("", "Saved on this laptop · syncing to GitHub");
      } else mergeNotes(d);
      // Live updates: new ones show a pill instead of shifting content under the cursor.
      const sig = d.updates.filter((u) => !u.missing).map((u) => `${u.user}:${u.footer?.time ?? ""}`);
      if (s.seen && sig.some((x) => !s.seen.includes(x)) && ($("#upd-list")?.scrollTop ?? 0) > 40) s.pill = sig.filter((x) => !s.seen.includes(x)).length;
      else s.seen = sig;
    } catch (e) {
      if (e.down || key !== s.key) return;
      s.error = e;
    }
    draw();
  }
  // A poll brought new Notes. Take them only if you're not typing and haven't unsaved edits.
  function mergeNotes(d) {
    if (d.notes === s.notesText) {
      if (!d.notesUnpushed && /syncing/.test(s.save.text)) setSave("ok", "Synced to GitHub");
      return;
    }
    if (s.dirty || s.ed?.isFocused()) return; // our next save meets a 409 and shows the conflict
    s.hash = d.notesHash;
    s.notesText = d.notes;
    if (s.ed) s.ed.setMarkdown(d.notes ?? "");
  }

  // ---------- saving: write on pause, sync to GitHub on leave / ⌘S (the server also syncs after 30 s) ----------

  function setSave(cls, text) {
    s.save = { cls, text };
    const el = $("#save-state");
    if (el) setHTML(el, saveHTML());
  }
  const saveHTML = () =>
    s.save.text
      ? html`<span class="dot ${s.save.cls === "bad" ? "bad" : s.save.cls === "ok" ? "" : s.save.text.startsWith("Editing") || s.save.text.startsWith("Saving") ? "busy" : "none"}"></span>${s.save.text}${s.save.cls === "bad" ? html` · <button data-act="sync">Retry</button>` : ""}`
      : "";
  function changed() {
    s.dirty = true;
    setSave("", "Editing…");
    clearTimeout(s.timer);
    s.timer = setTimeout(saveNow, 800);
  }
  async function saveNow() {
    clearTimeout(s.timer);
    if (!s.dirty || !s.ed || !s.data) return;
    const key = periodKey();
    const text = s.ed.getMarkdown();
    s.dirty = false;
    if (normal(text) === normal(s.notesText)) return setSave("", s.save.text === "Editing…" ? "Saved" : s.save.text);
    setSave("", "Saving…");
    try {
      const r = await put(`/page/${key}`, { text, hash: s.hash });
      s.hash = r.hash;
      s.notesText = text;
      forget("/page/"); // the cached answers no longer match the file
      setSave("", r.unpushed ? "Saved · syncing to GitHub shortly" : "Saved");
      clearTimeout(s.syncTimer);
      if (r.syncInMs != null) s.syncTimer = setTimeout(() => s.key && load(false), r.syncInMs + 4000);
    } catch (e) {
      s.dirty = true;
      if (e.status === 409 && e.data.theirs !== undefined) {
        s.conflict = { theirs: e.data.theirs, hash: e.data.hash, backup: null };
        setSave("bad", "Not saved: changed elsewhere");
        drawNotice();
      } else setSave("bad", `Not saved: ${e.message}`);
    }
  }
  async function syncNow() {
    if (s.dirty) await saveNow();
    if (!s.data || s.conflict) return;
    setSave("", "Syncing to GitHub…");
    try {
      const r = await post(`/page/${periodKey()}/sync`);
      s.hash = r.hash;
      setSave("ok", r.pushed ? `Synced to GitHub · ${time(new Date().toISOString())}` : r.note === "nothing changed" ? "Synced to GitHub" : `Saved · ${r.note ?? "not pushed"}`);
    } catch (e) {
      if (e.status === 409 && e.data.theirs !== undefined) {
        s.conflict = { theirs: e.data.theirs, hash: e.data.hash, backup: e.data.backup };
        setSave("bad", "Not synced: changed elsewhere");
        drawNotice();
      } else setSave("bad", `Couldn't sync to GitHub: ${e.message}`);
    }
  }
  async function flush({ quiet } = {}) {
    if (!s.data || quiet) return;
    if (s.dirty) await saveNow();
    if (s.data && !s.data.frozen && (s.notesText !== s.data.notes || s.data.notesUnpushed) && !s.conflict) post(`/page/${periodKey()}/sync`).catch(() => {});
  }
  const normal = (t) => String(t ?? "").replace(/\s+$/, "");
  const periodKey = () => `${s.data.project}/${s.data.cadence.name}/${s.data.period}`;

  async function resolve(which) {
    const c = s.conflict;
    if (!c) return;
    if (which === "theirs") {
      s.conflict = null;
      s.hash = c.hash;
      s.notesText = c.theirs;
      s.dirty = false;
      s.ed?.setMarkdown(c.theirs);
      setSave("", "Showing their version");
      drawNotice();
      return;
    }
    s.conflict = null;
    s.hash = c.hash;
    s.notesText = c.theirs;
    s.dirty = true;
    drawNotice();
    await saveNow();
    await syncNow();
  }

  async function startPage(btn) {
    await busy(btn, "Starting…", async () => {
      try {
        const r = await post(`/page/${s.data.project}/${s.data.cadence.name}`);
        s.data = r;
        s.hash = r.notesHash;
        s.notesText = r.notes;
        toast("Page started");
      } catch (e) {
        s.error = e;
      }
    });
    draw();
  }

  // ---------- drawing ----------

  function frame() {
    main._html = null;
    main.innerHTML = String(html`${bar(barTitle(), html`<span id="bar-right" class="bar-right"></span>`)}
      <div class="page ${s.showUpdates ? "show-updates" : ""}" id="page">
        <nav class="periods" id="periods" aria-label="Periods"></nav>
        <div class="doc-scroll" id="doc-scroll"><article class="doc">
          <div id="doc-head" class="doc-head"></div><div id="doc-notice"></div><div id="doc-body">${skeletonBlock(7)}</div><div id="doc-extras"></div>
        </article></div>
        <aside class="updates-col" id="updates" aria-label="Updates">
          <div class="resizer" data-resize="updates" title="Drag to resize, double-click to reset"></div>
          <div class="updates-head" id="upd-head"></div>
          <div class="updates-scroll" id="upd-list"><div class="sk-block"><span class="sk h20 w60"></span><span class="sk w90"></span><span class="sk w70"></span></div></div>
        </aside>
      </div>`);
    drawBar();
  }
  function barTitle() {
    const [p, c] = s.key.split("/");
    const proj = state.ctx.projects[p];
    return html`${proj?.name ?? p} <span class="mute">· ${proj?.cadences.find((x) => x.name === c)?.title ?? c}</span>`;
  }
  function drawBar() {
    const [p, c] = s.key.split("/");
    const d = s.data;
    const projs = Object.entries(state.ctx.projects).filter(([, x]) => x.cadences.some((k) => k.name === c));
    const switcher =
      projs.length > 1 && projs.length <= 4
        ? html`<div class="toggle-group labelled hide-narrow" role="group" aria-label="Project">${projs.map(([id, x]) => html`<a href="#/p/${id}/${c}" ${id === p ? raw('aria-current="page"') : ""}>${x.name}</a>`)}</div>`
        : "";
    setHTML(
      $("#bar-right"),
      html`<span class="save-state" id="save-state" role="status">${saveHTML()}</span>
      ${switcher}
      <a class="icon-btn ${d?.prev ? "" : "disabled"}" ${d?.prev ? raw(`href="#/p/${p}/${c}/${d.prev}"`) : raw('aria-disabled="true"')} title="Previous period (p)" aria-label="Previous period">${I.chevronLeft}</a>
      <a class="btn sm outline" href="#/p/${p}/${c}" title="Current period (.)" ${d?.isCurrent ? raw('aria-current="page"') : ""}>${d?.cadence.period === "week" ? "This week" : d?.cadence.period === "day" || !d ? "Today" : "Current"}</a>
      <a class="icon-btn ${d?.next ? "" : "disabled"}" ${d?.next ? raw(`href="#/p/${p}/${c}/${d.next}"`) : raw('aria-disabled="true"')} title="Next period (n)" aria-label="Next period">${I.chevronRight}</a>
      <button class="btn sm ghost hide-narrow" data-act="copy-summary" title="Copy a markdown summary for Slack or email">${I.copy}Copy summary</button>
      ${d ? html`<button class="btn sm outline only-narrow" data-act="toggle-updates" aria-expanded="${s.showUpdates}" title="Updates (u)">Updates ${d.counts.published}/${d.counts.members}</button>` : ""}`,
    );
  }

  function draw() {
    if (!$("#page", main)) frame();
    drawBar();
    drawPeriods();
    drawHead();
    drawNotice();
    drawBody();
    drawExtras();
    drawUpdates();
  }

  function drawPeriods() {
    const d = s.data;
    if (!d) return;
    const [p, c] = [d.project, d.cadence.name];
    const week = d.cadence.period === "week";
    setHTML(
      $("#periods"),
      d.periods.map(
        (x) => html`<a class="period" href="#/p/${p}/${c}/${x.period}" ${x.period === d.period ? raw('aria-current="page"') : ""} title="${x.frozen ? "Frozen: read-only" : ""}${x.hasNotes ? " · has notes" : ""}">
          <span class="lbl">${week ? `Week of ${x.label.replace(/^\w+ /, "")}` : x.label}</span>
          ${x.current ? html`<span class="now">${week ? "now" : "today"}</span>` : x.frozen ? I.lock : ""}
          ${x.hasNotes ? html`<span class="dot" title="Has notes"></span>` : ""}
          <span class="cnt mute" title="${x.updates} of ${x.members} updates">${x.updates}/${x.members}</span></a>`,
      ),
    );
  }

  function drawHead() {
    const d = s.data;
    if (!d) return setHTML($("#doc-head"), html`<span class="sk w30"></span>`);
    const week = d.cadence.period === "week";
    let status;
    if (d.frozen) status = html`<span class="frozen-badge">${I.lock}Frozen · read-only, the next period has started</span>`;
    else if (d.meetsAt) {
      const mins = (Date.parse(d.meetsAt) - Date.now()) / 60000;
      status = html`${I.clock}<span class="${mins > 0 && mins < 30 ? "soon" : ""}">Meets ${time(d.meetsAt)} · ${mins > 0 ? rel(d.meetsAt) : `started ${rel(d.meetsAt)}`}</span>${d.publishBy && Date.parse(d.publishBy) > Date.now() ? html`<span>· drafts publish by ${time(d.publishBy)}</span>` : ""}`;
    } else status = html`${I.calendar}<span>${d.isCurrent ? "Current period" : "Past period"}</span>`;
    setHTML(
      $("#doc-head"),
      html`<div class="doc-kicker">${d.cadence.title} · ${d.projectName}</div>
        <h2>${week ? `Week of ${longDay(d.period)}` : longDay(d.period)}</h2>
        <div class="doc-status">${status}</div>`,
    );
  }

  function drawNotice() {
    const c = s.conflict;
    setHTML(
      $("#doc-notice"),
      html`${s.error ? errorNotice(s.error) : ""}${
        c
          ? notice(
              "err",
              html`<b>This page changed elsewhere</b> (a teammate's edit, or another tab) since you opened it. Your text is still in the editor${c.backup ? html` and saved in <code>${c.backup}</code>` : ""}. Take their version, or keep yours (it replaces theirs; check you didn't drop their lines).`,
              html`<button class="btn sm outline" data-act="theirs">Reload theirs</button><button class="btn sm primary" data-act="mine">Keep mine</button>`,
            )
          : ""
      }`,
    );
  }

  async function drawBody() {
    const d = s.data;
    const el = $("#doc-body");
    if (!d) return;
    const k = periodKey();
    const editable = d.exists && d.notes !== null && !d.frozen;
    if (editable) {
      if (s.edKey === k) return;
      unmountEditor();
      s.edKey = k;
      el._html = null;
      el.innerHTML = String(skeletonBlock(4));
      const ed = await mountNotes(el, {
        markdown: d.notes,
        placeholder: `Notes for ${d.label}: decisions, action items, who said what…`,
        onChange: changed,
      });
      if (s.edKey !== k) return ed?.destroy();
      s.ed = ed;
      return;
    }
    unmountEditor();
    if (d.exists && d.notes !== null) setHTML(el, html`<div class="md doc-body">${md(d.notes)}</div>`);
    else if (d.isCurrent)
      setHTML(
        el,
        html`<div class="doc-empty"><h3>No page yet</h3>
          <p>Runs make the current period's page at their first run; you can start it now. Nothing is overwritten: if it already exists, this does nothing.</p>
          <button class="btn primary" data-act="start" data-write>${I.plus}Start the page</button>
          <p class="small">Starts with the cadence's headings (for example Notes, Decisions, Action items) and pushes it to the team's repo.</p></div>`,
      );
    else setHTML(el, html`<div class="doc-empty"><h3>Nobody wrote notes for this period</h3><p>Updates people published are still on the right.</p></div>`);
  }
  function unmountEditor() {
    s.ed?.destroy();
    s.ed = null;
    s.edKey = null;
  }

  function drawExtras() {
    const d = s.data;
    if (!d) return;
    const items = String(d.notes ?? "")
      .split("\n")
      .map((l) => /^\s*[-*] \[ \]\s+(.*\S.*)$/.exec(l)?.[1])
      .filter(Boolean);
    setHTML(
      $("#doc-extras"),
      items.length
        ? html`<section class="doc-panel" aria-label="Action items"><h3>Action items <span class="count">${plural(items.length, "open item")}</span></h3>
          ${items.map((t) => {
            const who = /@([\w-]+)/.exec(t)?.[1];
            return html`<div class="action-row">${who ? avatar(who) : html`<span class="av av-none"></span>`}<span class="grow md">${md(t)}</span></div>`;
          })}
          <p class="mute small">Unchecked boxes in the Notes. Turning them into issues goes through your agent ("turn this meeting into issues").</p></section>`
        : "",
    );
  }

  function ordered() {
    const d = s.data;
    const rank = (u) => (u.missing ? 2 : u.footer?.problem || u.footer?.notReviewed || u.blocked.length ? 0 : 1);
    let list = d.updates.map((u, i) => ({ u, i })).sort((a, b) => rank(a.u) - rank(b.u) || a.i - b.i).map((x) => x.u);
    if (s.filter === "blocked") list = list.filter((u) => !u.missing && u.blocked.length);
    if (s.filter === "problems") list = list.filter((u) => u.missing || u.footer?.problem || u.footer?.notReviewed);
    return list;
  }

  function drawUpdates() {
    const d = s.data;
    if (!d) return;
    setHTML(
      $("#upd-head"),
      html`<h3>Updates <span class="count">${d.counts.published} of ${d.counts.members}</span></h3>
        <div class="toggle-group labelled" role="group" aria-label="Show">${FILTERS.map(([v, l]) => html`<button data-filter="${v}" aria-pressed="${s.filter === v}" title="${v === "blocked" ? "Only updates with blockers (b)" : ""}">${l}</button>`)}</div>
        <button class="icon-btn only-narrow" data-act="toggle-updates" aria-label="Close updates">${I.x}</button>`,
    );
    const list = ordered();
    const rollup = d.blocked.length
      ? html`<section class="rollup" aria-label="Blocked"><h4>${I.ban}Blocked <span class="count">${d.blocked.length}</span></h4><ul>${d.blocked.map(
          (b) => html`<li><button class="av-btn" data-goto="${b.user}" title="Show ${b.user}'s update">${avatar(b.user, "sm")}</button><div class="md">${md(b.text)}</div></li>`,
        )}</ul></section>`
      : html`<section class="rollup clear"><h4>${I.checkCircle}Nothing blocked</h4></section>`;
    setHTML(
      $("#upd-list"),
      html`${s.pill ? html`<button class="btn xs primary new-pill" data-act="show-new">${plural(s.pill, "new update")}</button>` : ""}
      ${s.filter === "all" || s.filter === "blocked" ? rollup : ""}
      ${list.length ? list.map((u, n) => card(u, n === s.sel)) : html`<p class="mute small pad">${s.filter === "blocked" ? "Nobody has a blocker." : "No problems: every update is in and its run read every source."}</p>`}`,
    );
  }

  function card(u, sel) {
    if (u.missing) {
      const bad = u.reason.kind === "last-run-failed";
      return html`<article class="update missing ${bad ? "bad" : ""} ${sel ? "sel" : ""}" data-user="${u.user}" tabindex="-1">
        <header>${avatar(u.user)}<b>${u.user}</b>${u.me ? html`<span class="mute small">you</span>` : ""}<span class="chip ${bad ? "bad" : "none"}">${{ "draft-waiting": "In your draft", "not-due": "Not due yet", "never-ran": "Never ran", "past-period": "No update" }[u.reason.kind] ?? "No update yet"}</span></header>
        <p>${codeText(u.reason.text)}${u.reason.kind === "draft-waiting" ? html` · <a href="#/draft">Review it</a>` : ""}</p></article>`;
    }
    const f = u.footer;
    const chips = !f
      ? html`<span class="chip none" title="No run footer: written by hand">by hand</span>`
      : html`${f.problem ? html`<span class="chip bad" title="Sources: ${Object.entries(f.sources).map(([k, v]) => `${k} ${v}`).join(", ")}"><span class="dot bad"></span>${f.failed.join(", ")} failed</span>` : html`<span class="chip ok" title="Sources: ${Object.keys(f.sources).join(", ")} all ok"><span class="dot"></span>${f.time} · ok</span>`}
        ${f.notReviewed ? html`<span class="chip warn" title="Published on its own at the deadline: ${u.user} didn't review it"><span class="dot warn"></span>Not reviewed</span>` : ""}`;
    return html`<article class="update ${sel ? "sel" : ""}" data-user="${u.user}" tabindex="-1">
      <header>${avatar(u.user)}<b>${u.user}</b>${u.me ? html`<span class="mute small">you</span>` : ""}${u.lead ? html`<span class="mute small">lead</span>` : ""}${chips}</header>
      ${f?.problem ? html`<div class="health">${I.alert}<span><b>${f.failed.map(cap).join(", ")}</b> couldn't be read on this run (${f.time}), so this update may be missing work.</span></div>` : ""}
      <div class="md">${md(u.body, { shift: 1 })}</div></article>`;
  }
  const cap = (x) => (x === "github" ? "GitHub" : x[0].toUpperCase() + x.slice(1));

  function flashUser(user) {
    const el = $(`.update[data-user="${CSS.escape(user)}"]`, main);
    if (!el) return;
    s.showUpdates = true;
    $("#page")?.classList.add("show-updates");
    el.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    el.classList.add("flash");
    el.focus({ preventScroll: true });
    setTimeout(() => el.classList.remove("flash"), 60);
  }

  function summary() {
    const d = s.data;
    const lines = [`**${d.projectName} · ${d.cadence.title} · ${d.label}**`, ""];
    if (d.blocked.length) lines.push("Blocked:", ...d.blocked.map((b) => `- @${b.user}: ${b.text}`), "");
    lines.push(`Updates: ${d.counts.published} of ${d.counts.members} in.`);
    if (d.notes) lines.push("", d.notes.replace(/^# .*\n+/, "").trim());
    return lines.join("\n");
  }

  // ---------- events ----------

  main.onclick = (e) => {
    const f = e.target.closest("[data-filter]");
    if (f) {
      s.filter = localStorage.updatesFilter = f.dataset.filter;
      s.sel = -1;
      return drawUpdates();
    }
    const g = e.target.closest("[data-goto]");
    if (g) return flashUser(g.dataset.goto);
    const a = e.target.closest("[data-act]");
    if (!a) return;
    const act = a.dataset.act;
    if (act === "sync") syncNow();
    else if (act === "theirs" || act === "mine") resolve(act);
    else if (act === "start") startPage(a);
    else if (act === "toggle-updates") toggleUpdates();
    else if (act === "copy-summary") s.data && copy(summary(), "Summary copied as markdown");
    else if (act === "show-new") {
      s.pill = 0;
      s.seen = null;
      $("#upd-list").scrollTop = 0;
      load(false);
    }
  };
  function toggleUpdates(force) {
    s.showUpdates = force ?? !s.showUpdates;
    $("#page")?.classList.toggle("show-updates", s.showUpdates);
    drawBar();
  }
  function moveSel(dir) {
    const list = ordered();
    if (!list.length) return;
    s.sel = Math.max(0, Math.min(list.length - 1, s.sel + dir));
    drawUpdates();
    if (narrow()) toggleUpdates(true);
    $(".update.sel", main)?.scrollIntoView({ block: "nearest" });
  }
  const narrow = () => (main.parentElement?.clientWidth ?? innerWidth) < 900; // the updates column is a sheet (style.css)
  const step = (to) => to && (location.hash = `#/p/${s.data.project}/${s.data.cadence.name}/${to}`);

  open(route);
  return {
    poll: 60,
    help: [
      ["p", "Previous period"], ["n", "Next period"], [".", "Current period"], ["e", "Write in the Notes"],
      ["⌘ K", "Link an issue (in the Notes)"], ["⌘ S", "Save and sync to GitHub now"], ["u", "Show / jump to Updates"],
      ["j k", "Next / previous update"], ["b", "Only updates with blockers"], ["Esc", "Leave the editor"],
    ],
    refresh: (force) => (force ? load(false) : !s.dirty && load(false)),
    update: (r) => open(r),
    leave: flush,
    key(e, typing) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        syncNow();
        return true;
      }
      if (typing || mod || e.altKey || !s.data) {
        if (typing && e.key === "Escape" && s.dirty) saveNow();
        return false;
      }
      const run = {
        p: () => step(s.data.prev),
        n: () => step(s.data.next),
        ".": () => (location.hash = `#/p/${s.data.project}/${s.data.cadence.name}`),
        e: () => s.ed?.focus(),
        u: () => (narrow() ? toggleUpdates() : $("#upd-list .update, #upd-list .rollup")?.focus?.() ?? $("#upd-list").scrollTo(0, 0)),
        j: () => moveSel(1),
        k: () => moveSel(-1),
        b: () => ((s.filter = localStorage.updatesFilter = s.filter === "blocked" ? "all" : "blocked"), (s.sel = -1), drawUpdates()),
        // The open issue panel closes first (app.js); the updates sheet only exists on a narrow page.
        Escape: () => (s.showUpdates && narrow() && document.getElementById("detail").hidden ? (toggleUpdates(false), true) : false),
      }[e.key];
      if (!run) return false;
      e.preventDefault();
      return run() !== false;
    },
  };
}
