// Board (#/board?project=&person=&view=list|board&q=): the team's open issues, as MC's grouped list
// (default) or as columns (v). Status icon menus (s), j/k, Enter opens the docked issue panel,
// / filters. Moves are optimistic with Undo; the shared board store patches itself, no refetch.
import { state } from "../api.js";
import { $, $$, html, raw, setHTML, I, bar, avatar, statusIcon, prioIcon, freshBadge, errorNotice, notice, skeletonRows, monthDay, plural, pick } from "../ui.js";
import { board, loadBoard, onBoard, openIssue, panelRef, statusMenu, setStatus } from "../issues.js";

export function mount(main, route) {
  const s = {
    view: route.params.view || localStorage.boardView || "list",
    project: route.params.project || "",
    person: route.params.person || "",
    q: route.params.q || "",
    sel: null,
    order: [],
    shut: new Set(JSON.parse(localStorage.boardShut ?? '["__none"]')),
  };

  function persist() {
    const p = new URLSearchParams();
    if (s.project) p.set("project", s.project);
    if (s.person) p.set("person", s.person);
    if (s.view !== "list") p.set("view", s.view);
    if (s.q) p.set("q", s.q);
    const q = p.toString();
    history.replaceState(null, "", `#/board${q ? `?${q}` : ""}`);
  }

  function visible() {
    const q = s.q.trim().toLowerCase();
    const who = s.person === "me" ? state.ctx.user : s.person;
    return (board.data?.columns ?? []).map((col) => ({
      ...col,
      cards: col.cards.filter(
        (c) =>
          (!s.project || c.project === s.project) &&
          (!who || (who === "none" ? !c.assignees.length : c.assignees.includes(who))) &&
          (!q || `${c.ident} ${c.title} ${c.labels.join(" ")} ${c.kind ?? ""} ${c.assignees.join(" ")}`.toLowerCase().includes(q)),
      ),
    }));
  }

  // ---------- drawing ----------

  function frame() {
    const projs = Object.entries(state.ctx.projects);
    main._html = null;
    main.innerHTML = String(html`${bar(
      "Board",
      html`<span id="board-fresh"></span>
      ${projs.length > 1 ? html`<div class="toggle-group labelled hide-narrow" role="group" aria-label="Project" id="proj-filter"></div>` : ""}
      <button class="btn sm outline" data-act="person" id="person-btn" title="Filter by person"></button>
      <label class="input search">${I.search}<input id="q" type="search" placeholder="Filter issues" value="${s.q}" aria-label="Filter issues" autocomplete="off">${raw("<kbd>/</kbd>")}</label>
      <div class="toggle-group" role="group" aria-label="Layout" id="view-toggle"></div>`,
    )}<div id="board-notice"></div><div id="content" class="content"></div>`);
    $("#q", main).oninput = (e) => {
      s.q = e.target.value;
      persist();
      drawContent();
    };
    drawBar();
    drawContent();
  }
  function drawBar() {
    setHTML($("#board-fresh", main), freshBadge(board.data?.fetchedAt, !!board.loading && !!board.data));
    const pf = $("#proj-filter", main);
    if (pf)
      setHTML(pf, html`<button data-proj="" aria-pressed="${!s.project}">All</button>${Object.entries(state.ctx.projects).map(([id, p]) => html`<button data-proj="${id}" aria-pressed="${s.project === id}">${p.name}</button>`)}`);
    setHTML($("#person-btn", main), html`${s.person ? avatar(s.person === "me" ? state.ctx.user : s.person, "sm") : I.user}${s.person === "me" ? "Me" : s.person === "none" ? "Unassigned" : s.person || "Everyone"}`);
    setHTML(
      $("#view-toggle", main),
      html`<button data-view="list" aria-pressed="${s.view === "list"}" title="List (v)" aria-label="List">${I.list}</button><button data-view="board" aria-pressed="${s.view === "board"}" title="Board (v)" aria-label="Board">${I.board}</button>`,
    );
  }

  function drawContent() {
    const el = $("#content", main);
    if (!el) return;
    setHTML(
      $("#board-notice", main),
      html`${board.error && board.data ? errorNotice(board.error) : ""}${board.data?.errors?.length ? notice("", html`<b>Some repos couldn't be read</b>, so their issues are missing: ${board.data.errors.join(" · ")}`) : ""}`,
    );
    el.classList.toggle("flush", s.view === "board");
    if (!board.data) {
      setHTML(el, board.error ? html`<div class="column">${errorNotice(board.error)}</div>` : skeletonRows(12));
      return;
    }
    const cols = visible();
    const total = cols.reduce((n, c) => n + c.cards.length, 0);
    s.order = [];
    const keep = { top: el.scrollTop, left: $(".board", el)?.scrollLeft ?? 0, cols: $$(".cards", el).map((c) => c.scrollTop) };
    if (!total) {
      const all = board.data.columns.reduce((n, c) => n + c.cards.length, 0);
      setHTML(
        el,
        html`<div class="empty">${I.board}<h2>${all ? "No issues match" : "No open issues"}</h2><p>${all ? "Try another project, person or filter." : "Open issues in the team's repos show here. Agents and intake pull requests create them; so can anyone on GitHub."}</p>
        ${all ? html`<button class="btn outline sm" data-act="clear">Clear filters</button>` : ""}</div>`,
      );
      return;
    }
    if (s.view === "board") {
      setHTML(
        el,
        html`<div class="board" role="list" aria-label="Columns">${cols.map((col) => {
          const key = col.label ?? "__none";
          const shut = s.shut.has(key) && col.label === null;
          if (!shut) s.order.push(...col.cards.map((c) => c.ref));
          return shut
            ? html`<div class="col shut" data-col="${key}" role="listitem"><button class="col-head" data-toggle="${key}" title="Show ${col.name}" aria-expanded="false">${statusIcon("none")}<span>${col.name}</span><span class="count">${col.cards.length}</span></button></div>`
            : html`<div class="col" data-col="${key}" role="listitem" aria-label="${col.name}">
              <div class="col-head">${statusIcon(col.label ?? "none")}<span>${col.name}</span><span class="count">${col.cards.length}</span>${col.label === null ? html`<button class="ib" data-toggle="${key}" title="Collapse" aria-label="Collapse ${col.name}">${I.chevronLeft}</button>` : ""}</div>
              <div class="cards">${col.cards.length ? col.cards.map(card) : html`<div class="col-empty">${col.label === null ? "Every issue has a status." : "Drop an issue here, or press s on one."}</div>`}</div></div>`;
        })}</div>`,
      );
    } else {
      setHTML(
        el,
        html`<div role="list" aria-label="Issues">${cols.map((col) => {
          if (!col.cards.length) return "";
          const key = col.label ?? "__none";
          const shut = s.shut.has(key);
          if (!shut) s.order.push(...col.cards.map((c) => c.ref));
          return html`<section class="group"><button class="group-head" data-toggle="${key}" aria-expanded="${!shut}">${I.chevron}${statusIcon(col.label ?? "none")}<span>${col.name}</span><span class="count">${col.cards.length}</span>${col.label === null ? html`<span class="mute small">&nbsp;· needs a status</span>` : ""}</button>${shut ? "" : col.cards.map(row)}</section>`;
        })}</div>`,
      );
    }
    el.scrollTop = keep.top;
    const b = $(".board", el);
    if (b) b.scrollLeft = keep.left;
    $$(".cards", el).forEach((c, n) => (c.scrollTop = keep.cols[n] ?? 0));
  }

  const meta = (c) => html`${c.kind ? html`<span class="chip">${c.kind}</span>` : ""}${c.labels.slice(0, 2).map((l) => html`<span class="chip">${l}</span>`)}`;
  const statusBtn = (c) => html`<button class="ib" data-status="${c.ref}" aria-label="Status: ${c.statusName ?? "No status"}. Change (s)" title="${c.statusName ?? "No status"} · change (s)">${statusIcon(c.status ?? "none")}</button>`;
  function row(c) {
    const open = panelRef() === c.ref;
    return html`<div class="row ${s.sel === c.ref ? "sel" : ""} ${open ? "open" : ""}" data-ref-row="${c.ref}" role="listitem" tabindex="${s.sel === c.ref || (!s.sel && s.order[0] === c.ref) ? 0 : -1}" aria-label="${c.ident}, ${c.statusName ?? "No status"}: ${c.title}">
      ${statusBtn(c)}
      <span class="prio" title="Priority: ${c.priorityName ?? "none"}">${prioIcon(c.priority)}</span>
      <span class="ident" title="${c.ref}">${c.ident}</span>
      <span class="title">${c.title}</span>
      <span class="has-sum" title="${c.hasSummary ? "Has a living summary" : ""}">${c.hasSummary ? I.note : ""}</span>
      <span class="chips">${meta(c)}</span>
      ${c.assignees[0] ? avatar(c.assignees[0]) : html`<span class="av av-none" title="Unassigned"></span>`}
      <time datetime="${c.updatedAt}" title="Updated ${c.updatedAt}">${monthDay(c.updatedAt)}</time>
    </div>`;
  }
  function card(c) {
    return html`<div class="card ${s.sel === c.ref ? "sel" : ""}" data-ref-row="${c.ref}" draggable="true" role="listitem" tabindex="-1" aria-label="${c.ident}: ${c.title}">
      <div class="card-top">${statusBtn(c)}<span class="ident" title="${c.ref}">${c.ident}</span>${c.hasSummary ? html`<span class="has-sum" title="Has a living summary">${I.note}</span>` : ""}${c.assignees[0] ? avatar(c.assignees[0]) : ""}</div>
      <div class="card-title">${c.title}</div>
      ${c.priority || c.kind || c.labels.length ? html`<div class="card-foot"><span class="ib" title="Priority: ${c.priorityName ?? "none"}">${prioIcon(c.priority)}</span>${meta(c)}</div>` : ""}
    </div>`;
  }

  // ---------- behaviour ----------

  function select(ref, { open = false, focus = true } = {}) {
    s.sel = ref;
    drawContent();
    const el = $(`[data-ref-row="${CSS.escape(ref)}"]`, main);
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (focus) el?.focus({ preventScroll: true });
    if (open || panelRef()) openIssue(ref);
  }
  function move(d) {
    if (!s.order.length) return;
    const n = s.order.indexOf(s.sel);
    select(s.order[n < 0 ? 0 : Math.min(s.order.length - 1, Math.max(0, n + d))]);
  }
  async function personMenu() {
    const people = state.ctx.members.filter((m) => m !== state.ctx.user);
    const v = await pick("Show issues for", [["", "Everyone", I.people], ["me", `Me (${state.ctx.user})`, avatar(state.ctx.user)], ...people.map((m) => [m, m, avatar(m)]), ["none", "Unassigned", html`<span class="av av-none"></span>`]], s.person);
    if (v === undefined) return;
    s.person = v;
    persist();
    drawBar();
    drawContent();
  }
  const setView = (v) => {
    s.view = localStorage.boardView = v;
    persist();
    drawBar();
    drawContent();
  };

  main.onclick = (e) => {
    const st = e.target.closest("[data-status]");
    if (st) return e.stopPropagation(), (s.sel = st.dataset.status), statusMenu(st.dataset.status);
    const t = e.target.closest("[data-toggle]");
    if (t) {
      const k = t.dataset.toggle;
      s.shut.has(k) ? s.shut.delete(k) : s.shut.add(k);
      localStorage.boardShut = JSON.stringify([...s.shut]);
      return drawContent();
    }
    const v = e.target.closest("[data-view]");
    if (v) return setView(v.dataset.view);
    const p = e.target.closest("[data-proj]");
    if (p) return (s.project = p.dataset.proj), persist(), drawBar(), drawContent();
    const a = e.target.closest("[data-act]");
    if (a?.dataset.act === "person") return personMenu();
    if (a?.dataset.act === "clear") return (s.project = s.person = s.q = ""), ($("#q", main).value = ""), persist(), drawBar(), drawContent();
    const r = e.target.closest("[data-ref-row]");
    if (r) select(r.dataset.refRow, { open: true, focus: false });
  };
  // Drag and drop between columns (keyboard path: s).
  main.ondragstart = (e) => {
    const c = e.target.closest?.(".card");
    if (!c) return;
    e.dataTransfer.setData("text/plain", c.dataset.refRow);
    e.dataTransfer.effectAllowed = "move";
  };
  main.ondragover = (e) => {
    const col = e.target.closest?.(".col");
    if (!col || col.dataset.col === "__none") return;
    e.preventDefault();
    $$(".col.drop", main).forEach((c) => c !== col && c.classList.remove("drop"));
    col.classList.add("drop");
  };
  const clearDrop = () => $$(".col.drop", main).forEach((c) => c.classList.remove("drop"));
  main.ondragend = clearDrop;
  main.ondrop = (e) => {
    const col = e.target.closest?.(".col");
    clearDrop();
    if (!col || col.dataset.col === "__none") return;
    e.preventDefault();
    setStatus(e.dataTransfer.getData("text/plain"), col.dataset.col);
  };

  const off = onBoard(() => {
    drawBar();
    drawContent();
  });
  const onPanel = () => drawContent();
  document.addEventListener("houston:panel", onPanel);

  frame();
  loadBoard().catch(() => {});

  return {
    poll: 60,
    help: [["j k", "Move down / up"], ["Enter", "Open the issue"], ["s", "Change status"], ["o", "Open on GitHub"], ["v", "List / board"], ["/", "Filter"], ["Esc", "Close the issue"]],
    refresh: (force) => loadBoard(force).catch(() => {}),
    update(r) {
      s.project = r.params.project || "";
      s.person = r.params.person || "";
      s.view = r.params.view || s.view;
      drawBar();
      drawContent();
    },
    leave() {
      off();
      document.removeEventListener("houston:panel", onPanel);
      main.onclick = main.ondragstart = main.ondragover = main.ondragend = main.ondrop = null;
    },
    key(e, typing) {
      if (typing) {
        if (e.target.id === "q" && (e.key === "ArrowDown" || e.key === "Enter")) return e.preventDefault(), e.target.blur(), move(1), true;
        return false;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return false;
      const ref = s.sel ?? panelRef();
      const run = {
        j: () => move(1),
        ArrowDown: () => move(1),
        k: () => move(-1),
        ArrowUp: () => move(-1),
        Enter: () => ref && openIssue(ref),
        s: () => ref && statusMenu(ref),
        o: () => {
          const c = board.data?.columns.flatMap((x) => x.cards).find((x) => x.ref === ref);
          if (c) window.open(c.url, "_blank", "noreferrer");
        },
        v: () => setView(s.view === "list" ? "board" : "list"),
        "/": () => $("#q", main)?.focus(),
      }[e.key];
      if (!run) return false;
      e.preventDefault();
      run();
      return true;
    },
  };
}
