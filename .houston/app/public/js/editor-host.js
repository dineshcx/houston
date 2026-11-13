// Mounts the Notes editor: the vendored TipTap bundle (/vendor/editor.js, loaded lazily the first time
// a page screen needs it) with its toolbar, or a plain textarea + preview if the bundle can't load.
// Either way the page screen gets the same small handle and the same markdown in and out.
import { $, html, setHTML, I, kbd } from "./ui.js";
import { chipElement, pickIssue, openIssue } from "./issues.js";
import { md } from "./markdown.js";

let bundle; // Promise of the module, or of null when it can't load
const loadBundle = () => (bundle ??= import("/vendor/editor.js").catch((e) => (console.warn("Notes editor bundle didn't load; using the plain editor.", e), null)));
/** Start fetching the bundle early (e.g. when the sidebar is hovered); harmless if repeated. */
export const preloadEditor = () => loadBundle();

/**
 * el: an empty container. Returns { rich, getMarkdown(), setMarkdown(md), focus(), destroy() }.
 * onChange fires on every edit (never on open: opening a page never changes it).
 */
export async function mountNotes(el, { markdown, placeholder, onChange }) {
  const mod = await loadBundle();
  if (!el.isConnected) return null;
  if (!mod) return mountFallback(el, { markdown, placeholder, onChange });
  const { createNoteEditor, TOOLS } = mod;
  el.innerHTML = String(html`<div class="doc-toolbar" role="toolbar" aria-label="Formatting">
      ${TOOLS.map((t) => html`<button class="tool" data-tool="${t.id}" title="${t.label} (${t.key})" aria-label="${t.label}" aria-pressed="false">${I[t.id]}</button>`)}
      <span class="tool-sep"></span>
      <button class="tool wide" data-tool="issue" title="Link an issue (⌘K)">${I.link}<span>Link issue</span></button>
    </div>
    <div class="doc-rich" id="note-editor"></div>
    <p class="doc-hints">Type <code>##</code> for a heading, <code>-</code> for a list, <code>[ ]</code> for an action item. ${kbd("⌘K")} links an issue. Saved as you type.</p>`);
  const ed = createNoteEditor({
    element: $("#note-editor", el),
    markdown: markdown ?? "",
    editable: true,
    placeholder,
    renderChip: chipElement,
    onChange,
    onPickIssue: (insert) => pickIssue().then((ref) => ref && insert(ref)),
    onSelection: (editor) =>
      el.querySelectorAll(".tool[data-tool]").forEach((b) => {
        const on = !!TOOLS.find((t) => t.id === b.dataset.tool)?.active(editor);
        b.classList.toggle("on", on);
        b.setAttribute("aria-pressed", on);
      }),
  });
  $(".doc-toolbar", el).onmousedown = (e) => {
    const b = e.target.closest("[data-tool]");
    if (!b) return;
    e.preventDefault(); // keep the cursor in the page
    b.dataset.tool === "issue" ? ed.linkIssue() : ed.tool(b.dataset.tool);
  };
  // Keyboard users activate toolbar buttons with Enter/Space (mousedown never fires).
  $(".doc-toolbar", el).onclick = (e) => {
    const b = e.target.closest("[data-tool]");
    if (!b || e.detail) return; // detail > 0: a real mouse click, already handled
    b.dataset.tool === "issue" ? ed.linkIssue() : ed.tool(b.dataset.tool);
  };
  // A chip in the editor opens the issue panel on click (the chip is an atom, so this doesn't edit).
  $("#note-editor", el).addEventListener("click", (e) => {
    const chip = e.target.closest(".issue-ref[data-ref]");
    if (chip && !e.metaKey) openIssue(chip.dataset.ref);
  });
  return {
    rich: true,
    getMarkdown: () => ed.getMarkdown(),
    setMarkdown: (m) => ed.setMarkdown(m ?? ""),
    focus: () => ed.editor.commands.focus("end"),
    isFocused: () => ed.editor.isFocused,
    linkIssue: () => ed.linkIssue(),
    destroy: () => ed.destroy(),
  };
}

function mountFallback(el, { markdown, placeholder, onChange }) {
  let preview = false;
  el.innerHTML = String(html`<div class="fallback">
    <div class="doc-toolbar"><span class="mute small">Plain editor (markdown)</span><span class="spacer"></span>
      <button class="tool wide" data-fb="link">${I.link}<span>Link issue</span></button>
      <button class="tool wide" data-fb="preview" aria-pressed="false">Preview</button></div>
    <textarea aria-label="Notes" placeholder="${placeholder}"></textarea><div class="md doc-body" hidden></div>
    <p class="doc-hints">The rich editor didn't load, so this is the plain one: same file, same saving. ${kbd("⌘K")} links an issue.</p></div>`);
  const ta = $("textarea", el);
  const pv = $(".doc-body", el);
  ta.value = markdown ?? "";
  ta.oninput = () => onChange(ta.value);
  const link = () =>
    pickIssue().then((ref) => {
      if (!ref) return;
      ta.setRangeText(`${ref} `, ta.selectionStart, ta.selectionEnd, "end");
      onChange(ta.value);
      ta.focus();
    });
  ta.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      e.stopPropagation();
      link();
    }
  });
  el.querySelector(".doc-toolbar").onclick = (e) => {
    const b = e.target.closest("[data-fb]");
    if (!b) return;
    if (b.dataset.fb === "link") return link();
    preview = !preview;
    b.setAttribute("aria-pressed", preview);
    ta.hidden = preview;
    pv.hidden = !preview;
    if (preview) setHTML(pv, md(ta.value));
  };
  return {
    rich: false,
    getMarkdown: () => ta.value,
    setMarkdown: (m) => (ta.value = m ?? ""),
    focus: () => ta.focus(),
    isFocused: () => document.activeElement === ta,
    linkIssue: link,
    destroy: () => {},
  };
}
