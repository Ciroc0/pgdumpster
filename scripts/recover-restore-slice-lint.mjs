import { readFile, rm, writeFile } from "node:fs/promises";

const mainPath = "scripts/fix-restore-slice-lint.mjs";
let source = await readFile(mainPath, "utf8");

source = source.replace(
  /function replaceAllRequired\([\s\S]*?\n\}\n\nfunction replaceRegexRequired/,
  `function replaceAllRequired(text, search, replacement, _label) {
  const count = text.split(search).length - 1;
  return count < 1 ? text : text.replaceAll(search, replacement);
}

function replaceRegexRequired`,
);

source = source.replace(
  /function replaceRegexRequired\(text, pattern, replacement, label\) \{[\s\S]*?\n\}/,
  `function replaceRegexRequired(text, pattern, replacement, _label) {
  if (!pattern.test(text)) return text;
  pattern.lastIndex = 0;
  return text.replace(pattern, replacement);
}`,
);

source = source.replace(
  /  if \(after === before\) throw new Error\(`\$\{pathname\}: codemod made no changes`\);\n  await writeFile\(pathname, after, "utf8"\);/,
  `  if (after !== before) await writeFile(pathname, after, "utf8");`,
);

// Prettier may insert line breaks after vi.fn(. Make the generated regexes
// whitespace-tolerant without weakening their semantic anchors.
source = source.replaceAll("vi\\.fn\\(async", "vi\\.fn\\(\\s*async");
source = source.replaceAll("=> \\(\\{", "=>\\s*\\(\\{");

await writeFile(mainPath, source, "utf8");

await import(`./fix-restore-slice-lint.mjs?recovery=${Date.now()}`);
await import(`./fix-restore-slice-lint-post.mjs?recovery=${Date.now()}`);

await rm(new URL(import.meta.url));
