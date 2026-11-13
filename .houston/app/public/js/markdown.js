// A small markdown renderer for Notes (read-only), Updates, draft sections, summaries and PR notes.
// It escapes the source first and only then adds its own tags, so HTML in a file shows as text.
// Issue refs (owner/repo#n) become live issue chips (issues.js); `<!-- … -->` lines are hidden.
import { esc, raw } from "./ui.js";
import { chipHTML } from "./issues.js";

const SAFE_URL = /^(https?:\/\/|mailto:|#)/;
export const REF_RE = /(^|[^\w./-])([\w.-]+\/[\w.-]+#\d+)\b/g;

/** Every owner/repo#n in a text, unique, in order. */
export const refsIn = (text) => [...new Set([...String(text ?? "").matchAll(REF_RE)].map((m) => m[2]))];

function inline(s, opts) {
  // Stash code spans, links and chips so emphasis rules can't reach inside them.
  const stash = [];
  const keep = (h) => `\u0000${stash.push(h) - 1}\u0000`;
  s = s.replace(/`([^`]+)`/g, (_, c) => keep(`<code>${c}</code>`));
  s = s.replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, (m, text, href) => (SAFE_URL.test(href) ? keep(`<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`) : m));
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, href) => pre + keep(`<a href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>`));
  s = s.replace(REF_RE, (_, pre, ref) => pre + keep(opts.chips === false ? `<span class="ident">${ref}</span>` : String(chipHTML(ref))));
  s = s
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w*])\*([^*\s][^*]*)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_([^_\s][^_]*)_(?!\w)/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[i]);
}

/**
 * Headings, lists (with checkboxes), bold/italic, inline code, code blocks, links, issue chips.
 * opts.shift: add to heading levels (so a page's "#" sits under the screen's own title).
 */
export function md(src, opts = {}) {
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
      const n = Math.min(m[1].length + (opts.shift ?? 0), 6);
      out += `<h${n}>${inline(m[2], opts)}</h${n}>`;
    } else if ((m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line))) {
      const tag = /\d/.test(m[1]) ? "ol" : "ul";
      if (list !== tag) {
        close();
        out += `<${tag}>`;
        list = tag;
      }
      const task = /^\[([ xX])\]\s*(.*)$/.exec(m[2]);
      if (task) {
        const done = task[1] !== " ";
        out += `<li class="task${done ? " checked" : ""}"><input type="checkbox" disabled${done ? " checked" : ""} aria-label="${done ? "done" : "not done"}"><span>${inline(task[2], opts)}</span></li>`;
      } else out += /^(nothing|none|n\/a|-)\.?$/i.test(m[2].trim()) ? `<li class="nothing">${m[2]}</li>` : `<li>${inline(m[2], opts)}</li>`;
    } else if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      close();
      out += "<hr>";
    } else if (/^&lt;!--.*--&gt;$/.test(line.trim())) {
      // houston markers and other comments: not content
    } else if (!line.trim()) close();
    else {
      close();
      out += `<p>${inline(line, opts)}</p>`;
    }
  }
  if (code !== null) out += `<pre><code>${code}</code></pre>`;
  close();
  return raw(out);
}

/** Split a living summary ("**Goal:** …" paragraphs, "**Decisions:**" + list) into labelled parts. */
export function summaryParts(text) {
  const parts = [];
  let cur = null;
  for (const line of String(text ?? "").split("\n")) {
    const m = /^\*\*([^*:]+):\*\*\s*(.*)$/.exec(line.trim());
    if (m) {
      cur = { label: m[1], text: m[2] };
      parts.push(cur);
    } else if (cur) cur.text += `\n${line}`;
    else if (line.trim()) parts.push((cur = { label: "", text: line }));
  }
  return parts.map((p) => ({ ...p, text: p.text.trim() }));
}
