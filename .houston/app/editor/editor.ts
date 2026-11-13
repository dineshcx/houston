// The Notes editor: TipTap reading and writing markdown, so leads never see markdown syntax while
// _page.md stays plain markdown on GitHub. Adapted from Mission Control's public/editor.js.
// This file is NOT loaded by the app directly: `bun run build:editor` bundles it (with the TipTap
// devDependencies) into app/public/vendor/editor.js, which is committed. See docs/contributing.md.
import { Editor, Node, type AnyExtension, type ChainedCommands } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown, MarkdownManager } from "@tiptap/markdown";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Placeholder } from "@tiptap/extensions";

const REF = /[\w.-]+\/[\w.-]+#\d+/;

/**
 * An issue reference (owner/repo#123). Shown as a live chip; saved as plain text, so GitHub and
 * members' agents read it exactly as before.
 */
export const IssueRef = (renderChip: (ref: string) => HTMLElement) =>
  Node.create({
    name: "issueRef",
    group: "inline",
    inline: true,
    atom: true,
    selectable: true,
    addAttributes: () => ({ ref: { default: null } }),
    parseHTML: () => [{ tag: "span[data-issue-ref]", getAttrs: (el: HTMLElement) => ({ ref: el.getAttribute("data-issue-ref") }) }],
    renderHTML: ({ node }: any) => ["span", { "data-issue-ref": node.attrs.ref }, node.attrs.ref],
    addNodeView: () => ({ node }: any) => ({ dom: renderChip(node.attrs.ref) }),
    markdownTokenizer: {
      name: "issueRef",
      level: "inline",
      start: (src: string) => src.search(REF),
      tokenize: (src: string) => {
        const m = new RegExp(`^${REF.source}`).exec(src);
        if (m) return { type: "issueRef", raw: m[0], ref: m[0] };
      },
    },
    parseMarkdown: (token: any, h: any) => h.createNode("issueRef", { ref: token.ref }),
    renderMarkdown: (node: any) => node.attrs.ref,
  } as any);

type Tool = { id: string; label: string; key: string; run: (c: ChainedCommands) => ChainedCommands; active: (e: Editor) => boolean };

export const TOOLS: Tool[] = [
  { id: "h2", label: "Heading", key: "⌘⌥2", run: (c) => c.toggleHeading({ level: 2 }), active: (e) => e.isActive("heading", { level: 2 }) },
  { id: "h3", label: "Subheading", key: "⌘⌥3", run: (c) => c.toggleHeading({ level: 3 }), active: (e) => e.isActive("heading", { level: 3 }) },
  { id: "bold", label: "Bold", key: "⌘B", run: (c) => c.toggleBold(), active: (e) => e.isActive("bold") },
  { id: "italic", label: "Italic", key: "⌘I", run: (c) => c.toggleItalic(), active: (e) => e.isActive("italic") },
  { id: "bullet", label: "Bulleted list", key: "⌘⇧8", run: (c) => c.toggleBulletList(), active: (e) => e.isActive("bulletList") },
  { id: "ordered", label: "Numbered list", key: "⌘⇧7", run: (c) => c.toggleOrderedList(), active: (e) => e.isActive("orderedList") },
  { id: "task", label: "Action item (checkbox)", key: "⌘⇧9", run: (c) => c.toggleTaskList(), active: (e) => e.isActive("taskList") },
];

/** The extensions the editor uses, minus the DOM-only ones; also what the round-trip test uses. */
export const extensions = (renderChip: (ref: string) => HTMLElement = () => null as unknown as HTMLElement, placeholder = ""): AnyExtension[] => [
  StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
  TaskList,
  TaskItem.configure({ nested: true }),
  Placeholder.configure({ placeholder }),
  Markdown,
  IssueRef(renderChip),
];

/** markdown → editor document → markdown, without a DOM. The test checks Houston's pages survive it. */
export function roundTrip(markdown: string): string {
  const m = new MarkdownManager({ extensions: extensions() });
  return m.serialize(m.parse(markdown));
}

export type NoteEditorOptions = {
  element: HTMLElement;
  markdown: string;
  editable: boolean;
  placeholder?: string;
  renderChip: (ref: string) => HTMLElement;
  onChange: (markdown: string) => void;
  /** ⌘K: show a picker and call `insert` with the chosen owner/repo#n. */
  onPickIssue: (insert: (ref: string) => void) => void;
  onSelection?: (editor: Editor) => void;
};

export function createNoteEditor({ element, markdown, editable, placeholder = "", renderChip, onChange, onPickIssue, onSelection }: NoteEditorOptions) {
  const editor = new Editor({
    element,
    editable,
    // The app's CSP forbids inline <style>; the few ProseMirror base rules TipTap would inject are in style.css.
    injectCSS: false,
    contentType: "markdown",
    content: markdown,
    extensions: extensions(renderChip, placeholder),
    editorProps: { attributes: { class: "md doc-body rich", spellcheck: "true" } },
    onUpdate: ({ editor }) => onChange(editor.getMarkdown()),
    onSelectionUpdate: ({ editor }) => onSelection?.(editor),
    onTransaction: ({ editor }) => onSelection?.(editor),
  });

  // ⌘K: pick an issue and drop it in as a chip.
  editor.view.dom.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      e.stopPropagation();
      linkIssue();
    }
  });
  function linkIssue() {
    onPickIssue((ref) => editor.chain().focus().insertContent([{ type: "issueRef", attrs: { ref } }, { type: "text", text: " " }]).run());
  }

  return {
    editor,
    linkIssue,
    tool: (id: string) => TOOLS.find((t) => t.id === id)!.run(editor.chain().focus()).run(),
    getMarkdown: () => editor.getMarkdown(),
    /** Replace the content without counting it as an edit (used when the page changed elsewhere). */
    setMarkdown: (md: string) => editor.commands.setContent(md, { contentType: "markdown", emitUpdate: false }),
    setEditable: (on: boolean) => editor.setEditable(on),
    destroy: () => editor.destroy(),
  };
}
