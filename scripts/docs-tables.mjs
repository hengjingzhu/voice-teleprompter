// npm run docs:tables — writes the mouse and keyboard tables into the READMEs from public/shortcuts.js.
// Rewrites what is between <!-- shortcuts:start --> and <!-- shortcuts:end --> in README.md (English) and
// README.zh-CN.md (Chinese). A README that is missing, or has no markers, is skipped with a message.
// test/docs.test.mjs fails when a README's block differs from what this would write.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describeShortcuts } from '../public/shortcuts.js';
import { tl } from '../public/i18n.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const READMES = [
  { file: 'README.md', lang: 'en' },
  { file: 'README.zh-CN.md', lang: 'zh' },
];
export const START = '<!-- shortcuts:start -->';
export const END = '<!-- shortcuts:end -->';

const cell = (s) => String(s).replace(/\|/g, '\\|');

/** The two markdown tables (mouse, then keyboard) for one language. */
export function renderTables(lang) {
  const rows = describeShortcuts(lang);
  const T = (key) => tl(lang, key);
  const table = (head, list, input) => [
    `| ${T(head)} | ${T('sc.col.when')} | ${T('sc.col.action')} |`,
    '| --- | --- | --- |',
    ...list.map((r) => `| ${cell(input(r))} | ${cell(r.when)} | ${cell(r.action)} |`),
  ].join('\n');
  return [
    table('sc.col.mouse', rows.filter((r) => r.kind === 'mouse'), (r) => r.input),
    '',
    table('sc.col.key', rows.filter((r) => r.kind === 'key'), (r) => r.keys.map((k) => `<kbd>${k}</kbd>`).join(' / ')),
  ].join('\n');
}

/** text with the block between the markers replaced; null when the markers are missing or out of order. */
export function updateBlock(text, lang) {
  const a = text.indexOf(START);
  const b = text.indexOf(END, a + START.length);
  if (a < 0 || b < 0) return null;
  return `${text.slice(0, a + START.length)}\n\n${renderTables(lang)}\n\n${text.slice(b)}`;
}

/** @returns {Array<{ file: string, status: 'updated' | 'unchanged' | 'missing' | 'no-markers' }>} */
export function writeAll(root = ROOT, log = console.log) {
  return READMES.map(({ file, lang }) => {
    const full = path.join(root, file);
    if (!fs.existsSync(full)) { log(`Skipped ${file}: file not found`); return { file, status: 'missing' }; }
    const text = fs.readFileSync(full, 'utf8');
    const next = updateBlock(text, lang);
    if (next == null) { log(`Skipped ${file}: no ${START} … ${END} markers`); return { file, status: 'no-markers' }; }
    if (next === text) { log(`${file}: tables already up to date`); return { file, status: 'unchanged' }; }
    fs.writeFileSync(full, next);
    log(`${file}: tables updated`);
    return { file, status: 'updated' };
  });
}

const norm = (href) => (process.platform === 'win32' ? href.toLowerCase() : href);
if (process.argv[1] && norm(pathToFileURL(path.resolve(process.argv[1])).href) === norm(import.meta.url)) writeAll();
