// Today (#/today): the home screen. Your draft and its deadline, today's pages per project × cadence
// with who's in / blocked / failing, what needs attention, and the getting-started checklist.
import { get, post, cached, state, forget } from "../api.js";
import { $, html, setHTML, I, bar, avatar, teamBadge, countdown, notice, errorNotice, copyCmd, codeText, time, rel, ago, plural, skeletonBlock, toast, busy, shortDay } from "../ui.js";
import { chipHTML } from "../issues.js";
import { refreshSidebar } from "../app.js";

export function mount(main) {
  const s = { data: cached("/today"), error: null, prs: cached("/review"), loading: false };
  const draw = () => {
    const d = s.data;
    setHTML(
      main,
      html`${bar(html`Today <span class="mute">· ${d?.todayLabel ?? shortDay(state.ctx.today)}</span>`)}
      <div class="content" id="content"><div class="column">
        ${s.error ? errorNotice(s.error) : ""}
        ${d ? body(d, s) : skeletonBlock(8)}
      </div></div>`,
    );
  };
  async function refresh(force) {
    s.loading = true;
    try {
      s.data = await get("/today");
      s.error = null;
      if (s.data.intakePrs || force) get(`/review${force ? "?refresh=1" : ""}`).then((r) => ((s.prs = r), draw()), () => {});
      if (s.data.intakePrs === null) setTimeout(() => main.isConnected && refresh(false), 2500);
    } catch (e) {
      if (e.down) return;
      s.error = e;
    }
    s.loading = false;
    draw();
  }
  async function approve(btn) {
    await busy(btn, "Publishing…", async () => {
      try {
        const r = await post("/draft/publish");
        forget("/draft");
        const where = r.published?.pages.map((p) => `${state.ctx.projects[p.project]?.name ?? p.project} · ${state.ctx.projects[p.project]?.cadences.find((c) => c.name === p.cadence)?.title ?? p.cadence}`).join(", ");
        toast(where ? `Published to ${where}` : "Published");
      } catch (e) {
        document.dispatchEvent(new CustomEvent("houston:error", { detail: `Couldn't publish: ${e.message}` }));
      }
    });
    refresh(false);
    refreshSidebar();
  }
  async function startPage(btn) {
    await busy(btn, "Starting…", async () => {
      try {
        await post(`/page/${btn.dataset.project}/${btn.dataset.cadence}`);
        toast("Page started");
        location.hash = `#/p/${btn.dataset.project}/${btn.dataset.cadence}`;
      } catch (e) {
        document.dispatchEvent(new CustomEvent("houston:error", { detail: `Couldn't start the page: ${e.message}` }));
      }
    });
  }
  main.onclick = (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    if (b.dataset.act === "approve") approve(b);
    else if (b.dataset.act === "start-page") e.preventDefault(), startPage(b);
  };
  draw();
  refresh(false);
  return {
    refresh,
    poll: 60,
    help: [["⌘ ↵", "Approve & publish your draft"], ["Enter", "Open the focused page"]],
    key(e, typing) {
      if (!typing && (e.metaKey || e.ctrlKey) && e.key === "Enter" && s.data?.draft) {
        e.preventDefault();
        const b = $("[data-act=approve]", main);
        if (b && !b.disabled) approve(b);
        return true;
      }
    },
    leave() {
      main.onclick = null;
    },
  };
}

function body(d, s) {
  return html`
    <div class="today-head"><div class="kicker">${d.team} · ${d.user}</div><h2>${greeting()}</h2></div>
    ${d.lastRun?.outcome === "failed" ? notice("err", html`<b>Your last run failed ${ago(d.lastRun.at)}</b>${d.lastRun.note ? html`: ${d.lastRun.note}` : ""}. Run <code>houston doctor</code> to see why.`, copyCmd("houston doctor")) : ""}
    ${draftCard(d)}
    ${pagesPanel(d)}
    ${attention(d, s)}
    ${d.checklistDone ? "" : checklist(d)}`;
}

function greeting() {
  const h = Number(time(new Date().toISOString()).slice(0, 2));
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

function draftCard(d) {
  const dr = d.draft;
  if (!dr)
    return html`<div class="quiet-line">${I.draft}<span>No draft waiting. ${d.nextRunAt ? html`Your next run, about ${time(d.nextRunAt)}, writes one if there's something new.` : html`Your first run writes one: ${copyCmd("houston run")}`}</span></div>`;
  const mins = dr.publishesAt ? (Date.parse(dr.publishesAt) - Date.now()) / 60000 : Infinity;
  return html`<section class="draft-card ${mins < 5 ? "late" : mins < 15 ? "urgent" : ""}" aria-label="Your draft">
    <div class="top">
      <div class="grow">
        <h3>Your draft is ready to review</h3>
        <p class="mute">${dr.summary}</p>
      </div>
      ${countdown({ ...dr, overdue: dr.status === "overdue" }, "lg")}
    </div>
    ${dr.failedSources.length ? notice("", html`<b>${dr.failedSources.map((f) => f.name).join(", ")} couldn't be read</b> on this run, so the draft may be missing work. ${dr.failedSources.map((f) => f.why).join(" ")}`) : ""}
    <div class="acts">
      <a class="btn primary" href="#/draft">${I.draft}Review draft</a>
      ${dr.held ? "" : html`<button class="btn outline" data-act="approve" data-write>${I.send}Approve & publish <kbd>⌘↵</kbd></button>`}
      ${dr.edited ? html`<span class="chip">Edited by you</span>` : ""}
    </div>
  </section>`;
}

function seg(p) {
  const label = { published: "published", "not-reviewed": "not reviewed", "failed-source": "a source failed", missing: "no update yet" };
  return html`<span class="seg" title="${p.updates.map((u) => `${u.user}: ${label[u.state]}${u.reason ? ` (${u.reason})` : ""}`).join("\n")}">
    <span class="seg-bar" aria-hidden="true">${p.updates.map((u) => html`<i class="${u.state}"></i>`)}</span>
    <span class="tnum">${p.counts.published} of ${p.counts.members}</span></span>`;
}

function whenText(p) {
  if (!p.meetsAt) return html`<span class="when"></span>`;
  const t = time(p.meetsAt);
  if (!p.meetsToday) return html`<span class="when">${new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: state.ctx.timezone }).format(new Date(p.meetsAt))} ${t}</span>`;
  const mins = (Date.parse(p.meetsAt) - Date.now()) / 60000;
  return html`<span class="when ${mins > 0 && mins < 30 ? "soon" : ""}">${t}, ${mins > 0 ? rel(p.meetsAt) : `started ${rel(p.meetsAt)}`}</span>`;
}

function pagesPanel(d) {
  if (!d.pages.length)
    return html`<h3 class="section-title">Today's pages</h3><div class="panel"><div class="empty inline">No page is open today. Pages appear here on the days their cadence meets.</div></div>`;
  const rows = d.pages.map((p) =>
    p.exists
      ? html`<a class="page-row" href="#/p/${p.project}/${p.cadence}">
          ${teamBadge(p.projectName, "sm")}
          <span class="grow"><span class="name">${p.projectName} · ${p.cadenceTitle}</span>${p.meetsToday ? "" : html` <span class="mute small">week of ${shortDay(p.period)}</span>`}</span>
          ${whenText(p)}
          ${seg(p)}
          <span class="blk ${p.counts.blocked ? "" : "none"}">${p.counts.blocked ? `${p.counts.blocked} blocked` : p.counts.failedSource ? html`<span class="blk">${p.counts.failedSource} source failed</span>` : "Nothing blocked"}</span>
        </a>`
      : html`<div class="page-row missing">
          ${teamBadge(p.projectName, "sm")}
          <span class="grow"><span class="name">${p.projectName} · ${p.cadenceTitle}</span><span class="mute small"> · Page not made yet; the first run today makes it</span></span>
          ${whenText(p)}
          <span></span>
          <button class="btn xs ghost" data-act="start-page" data-project="${p.project}" data-cadence="${p.cadence}" data-write>${I.plus}Start it now</button>
        </div>`,
  );
  return html`<h3 class="section-title">Today's pages <span class="count">${plural(d.pages.length, "page")}</span></h3><div class="panel">${rows}</div>
    <div class="legend"><span><i class="dot"></i>published</span><span><i class="dot warn"></i>not reviewed</span><span><i class="dot bad"></i>a source failed</span><span><i class="dot none"></i>no update yet</span></div>`;
}

function attention(d, s) {
  const prs = s.prs?.prs ?? [];
  const rows = [];
  if (d.intakePrs)
    rows.push(
      ...(prs.length
        ? prs.map((p) => html`<a class="repo-row" href="#/review">${I.review}<div class="grow"><div class="name"><span>${p.title}</span></div><div class="sub">#${p.number} by ${p.author} · ${ago(p.updatedAt)} · ${plural(p.proposed?.length ?? 0, "proposed change")}</div></div><span class="btn sm outline">Review</span></a>`)
        : [html`<a class="repo-row" href="#/review">${I.review}<div class="grow"><div class="name">${plural(d.intakePrs, "intake pull request")} waiting</div></div><span class="btn sm outline">Review</span></a>`]),
    );
  for (const p of d.attention.people)
    rows.push(html`<a class="repo-row" href="#/people">${avatar(p.user, "lg")}<div class="grow"><div class="name"><span>${p.user}</span>${p.me ? html`<span class="chip">you</span>` : ""}</div><div class="sub ${p.health.level === "bad" ? "" : ""}">${codeText(p.health.text)}</div></div>
      <span class="chip ${p.health.level === "bad" ? "bad" : p.health.level === "warn" ? "warn" : "none"}"><span class="dot ${p.health.level}"></span>${{ bad: "run failed", warn: "may be missing work", none: "never ran" }[p.health.level] ?? "ok"}</span></a>`);
  for (const b of d.attention.myBlocked ?? []) rows.push(html`<div class="repo-row">${I.ban}<div class="grow">${chipHTML(b.ref, "wide")}</div><span class="chip bad">Blocked</span></div>`);
  if (!rows.length) return html`<h3 class="section-title">Needs attention</h3><div class="quiet-line">${I.checkCircle}Nothing needs you right now: no pull requests to review, and everyone's runs look fine.</div>`;
  return html`<h3 class="section-title">Needs attention <span class="count">${rows.length}</span></h3><div class="panel">${rows}</div>`;
}

function checklist(d) {
  const open = d.checklist.filter((c) => !c.done).length;
  return html`<h3 class="section-title">Getting started <span class="count">${d.checklist.length - open} of ${d.checklist.length} done</span></h3>
    <div class="panel"><ol class="steps">${d.checklist.map(
      (c) => html`<li class="${c.done ? "done" : ""}"><span class="tick" aria-label="${c.done ? "done" : "to do"}">${c.done ? I.check : ""}</span>
        <div><b>${c.label}</b>${c.detail ? html`<div class="sub">${codeText(c.detail)}</div>` : ""}</div>
        <div>${c.command && !c.done ? copyCmd(c.command) : c.link && c.id === "teammates" ? html`<button class="btn xs outline" data-copy="${c.link}">${I.copy}Copy repo link</button>` : ""}</div></li>`,
    )}</ol></div>
    <p class="mute small legend">Nothing here can break anything: each command only sets up this laptop.</p>`;
}

