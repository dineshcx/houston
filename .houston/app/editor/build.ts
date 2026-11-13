// Bundles editor.ts and its TipTap devDependencies into one minified ES module the app serves:
// app/public/vendor/editor.js, plus its sha256 in editor.sha256 so reviewers can check the
// committed blob is what this source builds (test/app.test.ts rebuilds and compares).
//   bun run build:editor            write the bundle and its hash
//   bun app/editor/build.ts <file>  write the bundle somewhere else (the test does this)
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const VENDOR = join(import.meta.dir, "../public/vendor");
const BANNER = "/* Houston Notes editor: TipTap 3.32.2 and ProseMirror (MIT licensed, https://tiptap.dev, https://prosemirror.net). Built from .houston/app/editor/editor.ts by `bun run build:editor`. */";

export async function buildEditor(): Promise<string> {
  const r = await Bun.build({ entrypoints: [join(import.meta.dir, "editor.ts")], target: "browser", format: "esm", minify: true, banner: BANNER });
  if (!r.success) throw new Error(`The editor didn't build:\n${r.logs.join("\n")}`);
  return r.outputs[0].text();
}

export const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

if (import.meta.main) {
  const code = await buildEditor();
  const out = process.argv[2] ?? join(VENDOR, "editor.js");
  writeFileSync(out, code);
  if (!process.argv[2]) writeFileSync(join(VENDOR, "editor.sha256"), `${sha256(code)}  editor.js\n`);
  console.log(`wrote ${out} (${Math.round(code.length / 1024)} KB, sha256 ${sha256(code)})`);
}
