// Script editor: raw text on the left, an estimated duration per block on the right, the total against 90 s at the top.
// Save writes back to script.md (the server backs up the old version first). If the file changes outside: no local edits → switch to the new version; local edits → offer a choice.
// Unsaved edits are kept in localStorage as you type: after a reload / close, the editor can restore them next time.

const DRAFT_KEY = 'tp.draft';

function readDraft() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { return null; }
}
function writeDraft(text) {
  try {
    if (text == null) localStorage.removeItem(DRAFT_KEY);
    else localStorage.setItem(DRAFT_KEY, JSON.stringify({ text, at: new Date().toISOString() }));
  } catch { /* private mode */ }
}

import { parseScript } from './parse.js';
import { estimate, fmtSec, TARGET_SEC, DEFAULT_WPM } from './estimate.js';
import { speakerColors } from './prompter.js';

export class Editor {
  constructor({ root, aliasMap, getStats, onSave, onClose, toast }) {
    Object.assign(this, { root, aliasMap, getStats, onSave, onClose, toast });
    this.ta = root.querySelector('#ed-text');
    this.preview = root.querySelector('#ed-preview');
    this.est = root.querySelector('#ed-est');
    this.wpm = root.querySelector('#ed-wpm');
    this.banner = root.querySelector('#ed-banner');
    this.base = '';
    this.timer = null;
    this.ta.addEventListener('input', () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.refresh(), 120);
    });
    root.querySelector('#ed-save').addEventListener('click', () => this.save());
    root.querySelector('#ed-close').addEventListener('click', () => this.close());
  }

  get dirty() {
    return this.ta.value !== this.base;
  }

  get isOpen() {
    return !this.root.hidden;
  }

  open(text) {
    this.base = text;
    this.ta.value = text;
    this.banner.textContent = '';
    this.root.hidden = false;
    const draft = readDraft();
    if (draft && draft.text !== text) this.offerDraft(draft);
    else writeDraft(null);
    this.refresh();
    this.ta.focus();
    this.ta.setSelectionRange(0, 0);
    this.ta.scrollTop = 0;
  }

  offerDraft(draft) {
    const when = new Date(draft.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const msg = document.createElement('span');
    msg.textContent = `有一份 ${when} 没保存的草稿 `;
    const take = document.createElement('button');
    take.textContent = '恢复草稿';
    take.onclick = () => { this.ta.value = draft.text; this.banner.textContent = ''; this.refresh(); };
    const drop = document.createElement('button');
    drop.textContent = '丢掉';
    drop.onclick = () => { writeDraft(null); this.banner.textContent = ''; };
    this.banner.append(msg, take, drop);
  }

  close() {
    if (this.dirty && !confirm('有没保存的修改，放弃吗？')) return;
    writeDraft(null);
    this.root.hidden = true;
    this.onClose?.();
  }

  async save() {
    const text = this.ta.value;
    try {
      await this.onSave(text);
      this.base = text;
      writeDraft(null);
      this.banner.textContent = '';
      this.refresh();
      this.toast?.('已保存到 script.md');
    } catch (e) {
      this.toast?.(`保存失败：${e.message}`);
    }
  }

  /** script.md was changed outside the editor */
  external(text) {
    if (text === this.ta.value) { this.base = text; this.refresh(); return; }
    if (!this.dirty) {
      this.base = text;
      this.ta.value = text;
      this.refresh();
      this.toast?.('script.md 在外面改过，已换成新版');
      return;
    }
    this.banner.textContent = '';
    const msg = document.createElement('span');
    msg.textContent = 'script.md 在外面改过了 ';
    const take = document.createElement('button');
    take.textContent = '用文件里的版本';
    take.onclick = () => { this.base = text; this.ta.value = text; this.banner.textContent = ''; this.refresh(); };
    const keep = document.createElement('button');
    keep.textContent = '保留我的';
    keep.onclick = () => { this.base = text; this.banner.textContent = ''; this.refresh(); };
    this.banner.append(msg, take, keep);
  }

  refresh() {
    if (this.dirty) writeDraft(this.ta.value);
    const parsed = parseScript(this.ta.value, this.aliasMap);
    const stats = this.getStats() || {};
    const wpm = stats.wpm || {};
    const { per, total } = estimate(parsed, wpm);
    const over = total > TARGET_SEC;
    this.est.textContent = `预计 ${fmtSec(total)} / ${fmtSec(TARGET_SEC)}${this.dirty ? '（未保存）' : ''}`;
    this.est.classList.toggle('over', over);
    this.wpm.textContent = parsed.speakers.map((s) => {
      const n = stats.samples?.[s]?.length || 0;
      return n ? `${s} ${Math.round(wpm[s])} 词/分（实测 ${n} 条）` : `${s} ${DEFAULT_WPM} 词/分（默认）`;
    }).join(' · ');

    const color = speakerColors(parsed);
    this.preview.textContent = '';
    parsed.blocks.forEach((b, i) => {
      const box = document.createElement('div');
      box.className = 'ed-block';
      box.style.setProperty('--spk', color(b.speaker));
      const head = document.createElement('div');
      head.className = 'ed-head';
      const who = document.createElement('b');
      who.textContent = b.speaker || '（没标说话人）';
      head.append(who);
      if (b.title) head.append(` · ${b.title}`);
      const sec = document.createElement('span');
      sec.className = 'ed-sec';
      sec.textContent = `${per[i].toFixed(1)} 秒`;
      head.append(sec);
      const body = document.createElement('div');
      body.className = 'ed-text';
      body.textContent = b.paras.map((pi) => {
        const p = parsed.paras[pi];
        return parsed.words.slice(p.wordStart, p.wordEnd).map((w) => w.text).join(' ');
      }).join('\n');
      box.append(head, body);
      this.preview.append(box);
    });
  }
}
