// The UI text table (public/i18n.js) and the docs generated from it stay in step with the code.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRINGS, LANGS, tl } from '../public/i18n.js';
import { SHORTCUTS, STATES } from '../public/shortcuts.js';
import { READMES, START, END, updateBlock } from '../scripts/docs-tables.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const PUBLIC_JS = fs.readdirSync(path.join(ROOT, 'public')).filter((f) => f.endsWith('.js')).map((f) => `public/${f}`);

// CJK ideographs, CJK punctuation (。，「」 and the full-width space), kana, and full-width forms (：（）)
const span = (a, b) => `${String.fromCodePoint(a)}-${String.fromCodePoint(b)}`;
const CJK = new RegExp(`[${span(0x3000, 0x30ff)}${span(0x3400, 0x4dbf)}${span(0x4e00, 0x9fff)}${span(0xf900, 0xfaff)}${span(0xff00, 0xffef)}]`);
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

const cjkLines = (text) => text.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => CJK.test(l)).map(([n, l]) => `${n}: ${l.trim()}`);

describe('i18n table', () => {
  test('en and zh have the same keys, no empty values, the same {placeholders}', () => {
    assert.deepEqual(LANGS, ['en', 'zh']);
    assert.deepEqual(Object.keys(STRINGS.zh).sort(), Object.keys(STRINGS.en).sort());
    for (const lang of LANGS) {
      for (const [k, v] of Object.entries(STRINGS[lang])) {
        assert.equal(typeof v, 'string', `${lang} ${k}`);
        assert.ok(v.trim().length > 0, `${lang} ${k} is empty`);
      }
    }
    for (const k of Object.keys(STRINGS.en)) assert.deepEqual(placeholders(STRINGS.zh[k]), placeholders(STRINGS.en[k]), `placeholders of ${k}`);
  });

  test('t fills placeholders, translates nested vars and returns a missing key as is', () => {
    assert.equal(tl('en', 'rv.missed', { n: 3 }), '3 words not matched');
    assert.equal(tl('zh', 'rv.missed', { n: 3 }), '没对上 3 个词');
    assert.equal(tl('en', 'media.info', { w: 1, h: 2, fps: 3, mime: { key: 'media.noRecorder' } }), 'Video 1×2 @3fps · Recording format This browser cannot record');
    assert.equal(tl('en', 'no.such.key'), 'no.such.key');
  });

  test('no CJK text outside i18n.js (server.mjs, public/*.js, index.html except the toggle)', () => {
    for (const f of ['server.mjs', ...PUBLIC_JS.filter((f) => f !== 'public/i18n.js')]) {
      assert.deepEqual(cjkLines(read(f)), [], `CJK in ${f}`);
    }
    const html = read('public/index.html');
    const toggle = /(<button[^>]*data-lang="zh"[^>]*>)中文(<\/button>)/;
    assert.match(html, toggle, 'the language toggle has its 中文 button');
    assert.deepEqual(cjkLines(html.replace(toggle, '$1$2')), [], 'CJK in public/index.html');
  });

  test('every key the page uses exists', () => {
    const keys = new Set(Object.keys(STRINGS.en));
    const used = [];
    const html = read('public/index.html');
    for (const m of html.matchAll(/data-i18n(?:-title|-placeholder)?="([^"]+)"/g)) used.push(['index.html', m[1]]);
    assert.ok(used.length > 20, 'index.html uses data-i18n');
    // Literal keys: t('…'), tl(lang, '…'), and any string literal that starts with a table prefix ('sr.network', 'err.createTake' …)
    const prefixes = new Set([...keys].map((k) => k.split('.')[0]));
    for (const f of PUBLIC_JS.filter((f) => f !== 'public/i18n.js')) {
      const src = read(f);
      for (const m of src.matchAll(/\bt\(\s*(['"`])([^'"`$]+)\1/g)) used.push([f, m[2]]);
      for (const m of src.matchAll(/\btl\(\s*\w+\s*,\s*(['"`])([^'"`$]+)\1/g)) used.push([f, m[2]]);
      for (const m of src.matchAll(/(['"])([a-z][a-zA-Z]*\.[a-zA-Z][\w.]*)\1/g)) if (prefixes.has(m[2].split('.')[0])) used.push([f, m[2]]);
    }
    for (const s of SHORTCUTS) used.push(['shortcuts.js', s.labelKey]);
    for (const st of STATES.filter((x) => !['boot', 'saving'].includes(x))) used.push(['shortcuts.js', `state.${st}`]);
    // Every code the server can answer with has a text
    for (const m of read('server.mjs').matchAll(/'(E_[A-Z_]+)'/g)) used.push(['server.mjs', `err.${m[1]}`]);
    const missing = used.filter(([, k]) => !keys.has(k)).map(([f, k]) => `${f}: ${k}`);
    assert.deepEqual([...new Set(missing)], []);
  });
});

// ── READMEs (written later; each check skips a README that is not there yet) ──
const readmes = READMES.map((r) => ({ ...r, path: path.join(ROOT, r.file) })).map((r) => ({ ...r, text: fs.existsSync(r.path) ? fs.readFileSync(r.path, 'utf8') : null }));

/** Does a <b>…</b> label match a value of the table? {placeholders} match anything; a trailing key hint (E, Ctrl+S, Esc) may be left out on either side. */
function labelMatches(label, values) {
  const norm = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  const strip = (s) => s.replace(/\s+(?:[A-Z]|Ctrl\+[A-Z]|Esc)$/, '');
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const text = norm(label);
  const forms = new Set([text, strip(text)]);
  return values.some((v) => {
    const n = norm(v);
    return [n, strip(n)].some((x) => {
      const re = new RegExp(`^${x.split(/\{\w+\}/).map(esc).join('.+')}$`);
      return [...forms].some((f) => re.test(f));
    });
  });
}

describe('READMEs', () => {
  test('<b> label check: placeholders and key hints', () => {
    const values = Object.values(STRINGS.en);
    assert.ok(labelMatches('Edit script E', values));
    assert.ok(labelMatches('Edit script', values));
    assert.ok(labelMatches('Sound check', values));
    assert.ok(labelMatches('Noise floor -52 dB, speech threshold -42.0 dB', values));
    assert.ok(!labelMatches('Edit the script', values));
    assert.ok(labelMatches('回到试音', Object.values(STRINGS.zh)));
  });

  for (const r of readmes) {
    test(`${r.file}: the shortcut tables match public/shortcuts.js`, (t) => {
      if (r.text == null) return t.skip(`${r.file} not written yet`);
      if (!r.text.includes(START) || !r.text.includes(END)) return t.skip(`${r.file} has no ${START} markers yet`);
      assert.equal(updateBlock(r.text, r.lang), r.text, `run npm run docs:tables`);
    });

    test(`${r.file}: every <b> label is real UI text`, (t) => {
      if (r.text == null) return t.skip(`${r.file} not written yet`);
      const values = Object.values(STRINGS[r.lang]);
      const bad = [...r.text.matchAll(/<b>([\s\S]*?)<\/b>/g)].map((m) => m[1]).filter((label) => !labelMatches(label, values));
      assert.deepEqual(bad, [], `labels in ${r.file} that the ${r.lang} UI does not show`);
    });

    test(`${r.file}: every docs/media image exists`, (t) => {
      if (r.text == null) return t.skip(`${r.file} not written yet`);
      const refs = [...new Set([...r.text.matchAll(/docs\/media\/[^\s)"'<>]+?\.png/g)].map((m) => m[0]))];
      const missing = refs.filter((p) => !fs.existsSync(path.join(ROOT, p)));
      assert.deepEqual(missing, []);
    });
  }
});
