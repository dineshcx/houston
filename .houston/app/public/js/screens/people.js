// People (#/people): one dense row per member, problems first. Health in plain words, today's
// updates per page as small squares, Blocked lines, and the newest day log on demand.
import { get, cached, state } from "../api.js";
import { html, setHTML, I, bar, avatar, errorNotice, skeletonRows, codeText, ago, shortDay, plural } from "../ui.js";
import { md } from "../markdown.js";

const RANK = { bad: 0, warn: 1, none: 2, ok: 3 };
const WORD = { bad: "Run failed", warn: "Needs a look", none: "No runs", ok: "Fine" };

export function mount(main) {
  const s = { data: cached("/people") ?? null, error: null };
  async function load() {
    try {
      s.data = await get("/people");
      s.error = null;
    } catch (e) {
      if (e.down) return;
      s.error = e;
    }
    draw();
  }
  function draw() {
    const d = s.data;
    const problems = d?.filter((p) => p.health.level !== "ok").length ?? 0;
    setHTML(
      main,
      html`${bar(html`People ${d ? html`<span class="mute">· ${problems ? `${plural(problems, "person", "people")} to look at` : "everyone's fine"}</span>` : ""}`)}
      <div class="content"><div class="column">
        ${s.error ? errorNotice(s.error) : ""}
        ${d ? body(d) : html`<div class="panel">${skeletonRows(5)}</div>`}
      </div></div>`,
    );
  }
  function body(list) {
    const sorted = [...list].sort((a, b) => RANK[a.health.level] - RANK[b.health.level]);
    const page = (t) => `${state.ctx.projects[t.project]?.name ?? t.project} · ${state.ctx.projects[t.project]?.cadences.find((c) => c.name === t.cadence)?.title ?? t.cadence}`;
    const label = { published: "published", "not-reviewed": "published, not reviewed", "failed-source": "published, a source failed", missing: "no update" };
    const rows = sorted.map((p) => {
      const lvl = p.health.level;
      const lastRun = p.run ? html`Last run ${ago(p.run.at)}` : p.lastSeen ? html`Last seen ${shortDay(p.lastSeen)}` : "";
      return html`<div class="person">
        ${avatar(p.user, "lg")}
        <div class="grow">
          <div class="name">${p.user}${p.me ? html`<span class="chip">you</span>` : ""}${p.lead ? html`<span class="chip">lead</span>` : ""}<span class="mute small">${lastRun}</span></div>
          <div class="health ${lvl}">${lvl === "ok" ? "" : lvl === "bad" ? I.alertCircle : I.alert}<span>${codeText(p.health.text)}</span></div>
        </div>
        <div class="right">
          <span class="squares" title="${p.today.map((t) => `${page(t)}: ${label[t.state]}${t.reason ? ` (${t.reason})` : ""}`).join("\n")}" aria-label="Today's updates: ${p.today.map((t) => `${page(t)} ${label[t.state]}`).join("; ")}">${p.today.map((t) => html`<i class="${t.state}"></i>`)}</span>
          <span class="chip ${lvl === "bad" ? "bad" : lvl === "warn" ? "warn" : lvl === "none" ? "none" : "ok"}"><span class="dot ${lvl}"></span>${WORD[lvl]}</span>
        </div>
        ${
          p.blocked.length || p.dayLog
            ? html`<div class="extra">
              ${p.blocked.map((b) => html`<div class="blocked-line">${I.ban}<span class="md">${md(b.text)}</span><a class="mute small" href="#/p/${b.project}/${b.cadence}/${b.period}">${page(b)}</a></div>`)}
              ${p.dayLog ? html`<details><summary>${I.chevron}Day log · ${shortDay(p.dayLog.date)}</summary><div class="md">${md(p.dayLog.preview.replace(/^## .*\n/, ""))}</div></details>` : ""}
            </div>`
            : ""
        }
      </div>`;
    });
    return html`<div class="panel" role="list" aria-label="Team members">${rows}</div>
      <div class="legend"><span>Squares: today's pages</span><span><i class="dot"></i>published</span><span><i class="dot warn"></i>not reviewed</span><span><i class="dot bad"></i>a source failed</span><span><i class="dot none"></i>no update</span></div>
      ${
        list.length === 1
          ? html`<div class="notice info">${I.people}<div class="grow"><b>Only you so far.</b> Send teammates the repo link; in it they tell their agent “set me up”.</div>${state.ctx.repo ? html`<div class="acts"><button class="btn sm outline" data-copy="https://github.com/${state.ctx.repo}">${I.copy}Copy repo link</button></div>` : ""}</div>`
          : html`<p class="mute small legend">Teammates' failed runs don't show here (a failed run publishes nothing); quiet days and failed sources in their last update do.</p>`
      }`;
  }
  draw();
  load();
  return { poll: 60, refresh: load, help: [] };
}

