// Review (#/review): open intake pull requests. Each shows its proposed changes first, as structured
// rows (kind icon, target issue chip, assignee/priority/status pills), then what was left out, then
// the meeting notes (collapsed). Merge goes through a dialog; apply would-refuse disables it.
import { get, post, cached, forget, state } from "../api.js";
import { $, $$, html, setHTML, I, bar, avatar, freshBadge, errorNotice, notice, skeletonBlock, ago, plural, toast, busy, confirmDialog, statusIcon, prioIcon, codeText } from "../ui.js";
import { chipHTML, prefetch, statusName } from "../issues.js";
import { md, refsIn } from "../markdown.js";
import { refreshSidebar } from "../app.js";

export function mount(main) {
  const s = { data: cached("/review") ?? null, error: null, loading: false, merged: [], sel: -1 };

  async function load(force) {
    s.loading = true;
    draw();
    try {
      const d = await get(`/review${force ? "?refresh=1" : ""}`);
      await prefetch(d.prs.flatMap((p) => [...(p.proposed ?? []).map((c) => c.target).filter((t) => t.includes("#")), ...(p.notes ?? []).flatMap((n) => refsIn(n.text))]), 1200);
      s.data = d;
      s.error = null;
    } catch (e) {
      if (e.down) return;
      s.error = e;
    }
    s.loading = false;
    draw();
  }

  function draw() {
    const d = s.data;
    setHTML(
      main,
      html`${bar("Review", html`${freshBadge(d?.fetchedAt, s.loading && !!d)}<button class="icon-btn" data-act="about" title="What is this?" aria-label="What is this screen?">${I.info}</button>`)}
      <div class="content" id="content"><div class="column">
        ${s.error ? errorNotice(s.error) : ""}
        ${localStorage.reviewLedeSeen || !d?.prs?.length ? "" : notice("info", html`<b>Intake pull requests</b> turn a meeting or thread into issue changes. Read the proposed changes, then Merge to approve them: the owner's next run applies them (or anyone runs <code>houston apply</code>). Nothing changes on GitHub until then.`, html`<button class="btn xs ghost" data-act="dismiss-lede">Got it</button>`)}
        ${!d ? skeletonBlock(8) : body(d)}
      </div></div>`,
    );
  }

  function body(d) {
    if (!d.repo) return html`<div class="empty">${I.review}<h2>No GitHub repo for this team yet</h2><p>Review lists intake pull requests on the Houston repo's GitHub origin. Push the repo to GitHub to use it.</p></div>`;
    const open = d.prs.filter((p) => !s.merged.some((m) => m.number === p.number && !m.showing));
    return html`${
      open.length
        ? open.map((p, n) => pr(p, n === s.sel))
        : html`<div class="empty">${I.checkCircle}<h2>Nothing to review</h2><p>Say “turn this meeting into issues” to your agent in this repo, and the pull request shows up here for you to approve.</p></div>`
    }
      ${s.merged.filter((m) => !m.showing).length ? html`<h3 class="section-title">Merged this session <span class="count">${s.merged.length}</span></h3><div class="panel">${s.merged.map((m) => html`<a class="repo-row" href="${m.url}" target="_blank" rel="noreferrer">${I.gitMerge}<div class="grow"><div class="name"><span>${m.title}</span></div><div class="sub">#${m.number} · merged ${ago(m.at)} · waiting for the owner's next run to apply it</div></div></a>`)}</div>` : ""}`;
  }

  function pr(p, sel) {
    const merged = s.merged.find((m) => m.number === p.number);
    const changes = p.proposed ?? [];
    const kinds = ["create", "update", "comment"].map((k) => [k, changes.filter((c) => c.kind === k).length]).filter(([, n]) => n);
    const why = p.error ?? p.refused ?? (p.proposalPath === null ? "This pull request has no proposal file, so merging changes nothing on GitHub." : null);
    return html`<article class="panel pr ${merged ? "merged" : ""} ${sel ? "sel" : ""}" data-pr="${p.number}" tabindex="-1" aria-label="Pull request ${p.number}: ${p.title}">
      <header class="panel-head">${I.review}<div class="grow"><h3><a href="${p.url}" target="_blank" rel="noreferrer">${p.title}</a></h3><div class="meta">#${p.number} by ${p.author} · ${ago(p.updatedAt)}${p.project ? ` · ${p.project}` : ""}</div></div>
        <a class="btn sm outline" href="${p.url}" target="_blank" rel="noreferrer" title="Open on GitHub (o)">${I.external}Open on GitHub</a>
        ${merged ? html`<span class="chip ok">${I.gitMerge}Merged · waiting for apply</span>` : html`<button class="btn sm primary" data-act="merge" data-n="${p.number}" data-write ${why && (p.refused || p.error) ? html`disabled title="${why}"` : html`title="Merge (m)"`}>${I.gitMerge}Merge</button>`}
      </header>
      ${p.error ? html`<div class="pr-sec">${notice("err", html`<b>Couldn't read this pull request.</b> ${p.error}`)}</div>` : ""}
      ${p.refused ? html`<div class="pr-sec">${notice("err", html`<b>Apply would refuse this:</b> ${codeText(p.refused)}`)}</div>` : ""}
      ${
        changes.length
          ? html`<div class="pr-sec"><h4>${plural(changes.length, "proposed change")}${kinds.length ? html`<span class="mute">· ${kinds.map(([k, n]) => `${n} ${k}`).join(", ")}</span>` : ""}</h4>${changes.map(change)}</div>`
          : p.error ? "" : html`<div class="pr-sec"><p class="mute small">${p.proposalPath === null ? "No proposal file: merging only adds the notes." : "No changes proposed."}</p></div>`
      }
      ${p.skipped?.length ? html`<div class="pr-sec"><h4>Left out <span class="count">${p.skipped.length}</span></h4>${p.skipped.map((x) => html`<div class="left-out">${I.ban}<span>${x}</span></div>`)}</div>` : ""}
      ${(p.notes ?? []).map((n) => html`<div class="pr-sec"><details><summary>${I.chevron}Notes · ${n.path}</summary><div class="md">${md(n.text, { shift: 1 })}</div></details></div>`)}
    </article>`;
  }

  function change(c) {
    const f = c.fields;
    const icon = { create: I.plus, update: I.refresh, comment: I.message }[c.kind];
    const pills = html`${f.assignee ? html`<span class="pill" title="Assignee">${avatar(f.assignee, "sm")}${f.assignee}</span>` : ""}
      ${f.priority ? html`<span class="pill" title="Priority">${prioIcon(f.priority)}${state.ctx.priority[f.priority] ?? f.priority.toUpperCase()}</span>` : ""}
      ${f.kind ? html`<span class="chip">${f.kind}</span>` : ""}
      ${f.status ? html`<span class="pill" title="Status after">${statusIcon(f.status)}→ ${statusName(f.status)}</span>` : ""}`;
    if (c.kind === "create")
      return html`<div class="change"><span class="kind create" title="Create an issue">${icon}</span><div>
        <div class="line1"><span class="what">New issue in ${f.repo}</span>${pills}</div>
        <div class="text">${f.title}</div>
        ${f.goal ? html`<div class="sub">Goal: ${f.goal}</div>` : ""}${f.next_step ? html`<div class="sub">Next step: ${f.next_step}</div>` : ""}${f.raised_by ? html`<div class="sub">Raised by ${f.raised_by}</div>` : ""}</div></div>`;
    if (c.kind === "update")
      return html`<div class="change"><span class="kind update" title="Update an issue">${icon}</span><div>
        <div class="line1"><span class="what">Update</span>${chipHTML(f.issue, "wide")}${pills}</div>
        ${f.add_decision ? html`<div class="text">Decision: ${f.add_decision}</div>` : ""}${f.add_question ? html`<div class="text">Question: ${f.add_question}</div>` : ""}${f.next_step ? html`<div class="text">Next step: ${f.next_step}</div>` : ""}</div></div>`;
    return html`<div class="change"><span class="kind" title="Comment on an issue">${icon}</span><div>
      <div class="line1"><span class="what">Comment on</span>${chipHTML(f.issue, "wide")}</div>
      <div class="text clamp" title="${f.body}">“${f.body}”</div></div></div>`;
  }

  async function merge(btn) {
    const p = s.data.prs.find((x) => x.number === Number(btn.dataset.n));
    const n = p.proposed?.length ?? 0;
    const ok = await confirmDialog({
      title: `Merge #${p.number}?`,
      body: html`<p>This approves ${plural(n, "change")} from “${p.title}”.</p><p>${p.owner ? `${p.owner}'s` : "The owner's"} next run applies them, or run <code>houston apply</code>. Nothing changes on GitHub until then.</p>`,
      confirm: "Merge",
    });
    if (!ok) return;
    await busy(btn, "Merging…", async () => {
      try {
        await post(`/review/${p.number}/merge`);
        const m = { number: p.number, title: p.title, url: p.url, at: new Date().toISOString(), showing: true };
        s.merged.push(m);
        toast(`Merged #${p.number}. The next run applies it.`);
        draw();
        // The card stays 5 s, greyed, then moves to "Merged this session".
        setTimeout(() => {
          m.showing = false;
          forget("/review");
          if (main.isConnected) draw();
          refreshSidebar();
        }, 5000);
      } catch (e) {
        document.dispatchEvent(new CustomEvent("houston:error", { detail: `Couldn't merge #${p.number}: ${e.message}` }));
      }
    });
  }

  main.onclick = (e) => {
    const a = e.target.closest("[data-act]");
    if (!a) return;
    if (a.dataset.act === "merge") merge(a);
    else if (a.dataset.act === "dismiss-lede" || a.dataset.act === "about") {
      if (localStorage.reviewLedeSeen) delete localStorage.reviewLedeSeen;
      else localStorage.reviewLedeSeen = "1";
      draw();
    }
  };

  draw();
  load(false);
  const prs = () => $$(".pr", main);
  function moveSel(d) {
    const list = prs();
    if (!list.length) return;
    s.sel = Math.max(0, Math.min(list.length - 1, s.sel + d));
    draw();
    prs()[s.sel]?.scrollIntoView({ block: "nearest" });
  }
  return {
    poll: 60,
    help: [["j k", "Next / previous pull request"], ["m", "Merge (opens a confirm)"], ["o", "Open on GitHub"]],
    refresh: (force) => load(force),
    leave: () => (main.onclick = null),
    key(e, typing) {
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return false;
      const cur = prs()[s.sel];
      const run = {
        j: () => moveSel(1),
        k: () => moveSel(-1),
        m: () => {
          const b = cur && $("[data-act=merge]", cur);
          if (b && !b.disabled) merge(b);
        },
        o: () => cur && window.open($("h3 a", cur).href, "_blank", "noreferrer"),
      }[e.key];
      if (!run) return false;
      e.preventDefault();
      run();
      return true;
    },
  };
}
