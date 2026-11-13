// Setup (#/setup): how the team works, in plain words. Read-only by design: changes go through your
// agent ("ask your agent"), so the same checks run. Sections from GET /api/setup, plus "Your laptop"
// from GET /api/doctor, and the raw `houston explain` text behind a toggle.
import { get, cached } from "../api.js";
import { html, setHTML, I, bar, avatar, teamBadge, errorNotice, notice, skeletonBlock, copyCmd, codeText, freshBadge, plural } from "../ui.js";

const prompts = (d) => [
  `Add a weekly retro cadence for ${d.projects[0]?.name ?? "our project"} on Fridays at 16:00`,
  "Let agents comment on issues for any update, not only blockers",
  `Add a new teammate to the team${d.projects[1] ? ` and to ${d.projects[1].name}` : ""}`,
];

export function mount(main) {
  const s = { data: cached("/setup") ?? null, doctor: cached("/doctor") ?? null, error: null, docErr: null, plain: false, docLoading: false };
  async function load(force) {
    try {
      s.data = await get("/setup");
      s.error = null;
    } catch (e) {
      if (e.down) return;
      s.error = e;
    }
    draw();
    s.docLoading = true;
    draw();
    try {
      s.doctor = await get(`/doctor${force ? "?refresh=1" : ""}`);
      s.docErr = null;
    } catch (e) {
      if (e.down) return;
      s.docErr = e;
    }
    s.docLoading = false;
    draw();
  }
  function draw() {
    const d = s.data;
    setHTML(
      main,
      html`${bar("Setup", d ? html`<div class="toggle-group labelled" role="group" aria-label="View"><button data-plain="0" aria-pressed="${!s.plain}">Sections</button><button data-plain="1" aria-pressed="${s.plain}">Plain text</button></div>` : "")}
      <div class="content"><div class="column narrow settings">
        ${s.error ? errorNotice(s.error) : ""}
        ${!d ? skeletonBlock(10) : s.plain ? html`<div class="panel"><pre class="plain">${d.explain.output}</pre></div><h2>Validation</h2><div class="panel"><pre class="plain">${d.validate.output}</pre></div>` : body(d)}
      </div></div>`,
    );
  }
  function body(d) {
    const wd = (x) => html`<span class="chip">${x}</span>`;
    return html`
      ${notice(
        "info",
        html`<b>To change any of this, ask your agent in this repo.</b> It edits <code>houston.yml</code> and <code>cadences/</code>, validates them, and opens a pull request if your team reviews setup changes.`,
      )}
      <div class="panel">${prompts(d).map((p) => html`<div class="prompt-row">${I.message}<q>${p}</q><button class="btn xs ghost" data-copy="${p}" title="Copy">${I.copy}Copy</button></div>`)}</div>

      <h2>${d.team.name}</h2>
      <p class="lede">${plural(d.team.members.length, "member")}${d.repo ? html` · <a href="https://github.com/${d.repo}" target="_blank" rel="noreferrer">${d.repo}</a>` : ""} · core ${d.core.version}${d.core.wanted && d.core.wanted !== d.core.version ? html` <span class="chip warn">houston.yml wants ${d.core.wanted}</span>` : ""}</p>
      <div class="panel">${d.team.members.map((m) => html`<div class="repo-row">${avatar(m, "lg")}<div class="grow"><div class="name">${m}${d.team.leads.includes(m) ? html`<span class="chip">lead</span>` : ""}${m === d.you.user ? html`<span class="chip">you</span>` : ""}</div></div></div>`)}</div>

      <h2>Projects</h2>
      <p class="lede">Each project has its repos and its cadences: a cadence is a recurring meeting with one page per period.</p>
      ${d.projects.map(
        (p) => html`<div class="panel"><div class="panel-head">${teamBadge(p.name, "sm")}<h3>${p.name}</h3>${p.mine ? html`<span class="chip">you work here</span>` : ""}</div>
          ${p.repos.map((r) => html`<div class="repo-row">${I.board}<div class="grow"><div class="name"><span>${r.repo}</span></div><div class="sub">${r.about ?? "No description"} · ${r.linkedAt ? html`linked at <code>${r.linkedAt}</code>` : "not linked on this laptop"}</div></div></div>`)}
          ${p.cadences.map((c) =>
            c.missing
              ? html`<div class="repo-row">${I.alert}<div class="grow"><div class="name">${c.title}</div><div class="sub err">The cadence file for “${c.name}” is missing.</div></div></div>`
              : html`<a class="repo-row" href="#/p/${p.id}/${c.name}">${I.calendar}<div class="grow"><div class="name"><span>${c.title}</span></div><div class="sub">${c.periodText} · written by ${c.writers.join(" and ")}</div></div>${wd(c.scheduleText)}</a>`,
          )}</div>`,
      )}

      <h2>Statuses</h2>
      <p class="lede">The board's columns, in order. Each is a <code>status:</code> label on GitHub.</p>
      <div class="ref-list">${d.statuses.map((x) => html`<span class="pill">${x.name}</span>`)}</div>
      <p class="lede small">Priorities: ${Object.entries(d.priority).map(([k, v]) => `${k.toUpperCase()} ${v}`).join(" · ")}</p>

      <h2>What agents may do</h2>
      <div class="panel">${d.rules.sentences.map((x) => html`<div class="rule">${I.check}<span>${x}</span></div>`)}</div>

      <h2>How runs publish</h2>
      <p class="lede">${codeText(d.publishing)}</p>

      <h2>Checks</h2>
      ${d.validation.ok ? notice("ok", html`<b>All valid.</b> <code>houston.yml</code> and <code>cadences/</code> pass every check.`) : html`<div class="panel">${d.validation.problems.map((x) => html`<div class="check-row"><span class="mark fail">${I.alertCircle}</span><pre class="plain">${x}</pre></div>`)}</div>`}

      <h2>Your laptop</h2>
      <p class="lede">From <code>houston doctor</code>: ${d.you.user} · ${d.you.timezone} · ${d.you.schedule ?? "no schedule set"} · core ${d.you.trusted ? "trusted" : "not trusted yet"} ${freshBadge(s.doctor?.fetchedAt, s.docLoading && !!s.doctor)}</p>
      ${s.docErr ? errorNotice(s.docErr) : ""}
      ${
        s.doctor
          ? html`<div class="panel">${[...s.doctor.checks].sort((a, b) => "fwo".indexOf(a.mark[0]) - "fwo".indexOf(b.mark[0])).map(
              (c) => html`<div class="check-row"><span class="mark ${c.mark}" aria-label="${c.mark}">${c.mark === "ok" ? I.check : c.mark === "warn" ? I.alert : I.alertCircle}</span><div class="grow">${c.text}${c.fix ? html`<div class="sub">${codeText(c.fix)}</div>` : ""}</div>${c.fix && /`([^`]+)`/.test(c.fix) ? copyCmd(/`([^`]+)`/.exec(c.fix)[1]) : ""}</div>`,
            )}</div>`
          : s.docErr ? "" : skeletonBlock(4)
      }`;
  }
  main.onclick = (e) => {
    const b = e.target.closest("[data-plain]");
    if (b) (s.plain = b.dataset.plain === "1"), draw();
  };
  draw();
  load(false);
  return { refresh: load, leave: () => (main.onclick = null), help: [] };
}
