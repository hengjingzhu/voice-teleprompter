// Script editor: raw text on the left, an estimated duration per block on the right, the total at the top (against the Target line, if the script has one).
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
import { estimate, fmtSec, DEFAULT_WPM } from './estimate.js';
import { speakerColors } from './prompter.js';
import { t, htmlLang } from './i18n.js';

export class Editor {
  constructor({ root, aliasMap, getStats, onSave, onClose, toast }) {
    Object.assign(this, { root, aliasMap, getStats, onSave, onClose, toast });
    this.ta = root.querySelector('#ed-text');
    this.preview = root.querySelector('#ed-preview');
    this.est = root.querySelector('#ed-est');
    this.wpm = root.querySelector('#ed-wpm');
    this.banner = root.querySelector('#ed-banner');
    this.notice = null; // what the banner offers: { kind: 'draft', draft } | { kind: 'external', text } | null
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
    this.setNotice(null);
    this.root.hidden = false;
    const draft = readDraft();
    if (draft && draft.text !== text) this.setNotice({ kind: 'draft', draft });
    else writeDraft(null);
    this.refresh();
    this.ta.focus();
    this.ta.setSelectionRange(0, 0);
    this.ta.scrollTop = 0;
  }

  setNotice(notice) {
    this.notice = notice;
    this.renderBanner();
  }

  renderBanner() {
    this.banner.textContent = '';
    const n = this.notice;
    if (!n) return;
    const msg = document.createElement('span');
    const button = (key, onclick) => {
      const b = document.createElement('button');
      b.textContent = t(key);
      b.onclick = onclick;
      return b;
    };
    if (n.kind === 'draft') {
      const when = new Date(n.draft.at).toLocaleTimeString(htmlLang(), { hour: '2-digit', minute: '2-digit' });
      msg.textContent = t('ed.draft', { time: when });
      const take = button('ed.restoreDraft', () => { this.ta.value = n.draft.text; this.setNotice(null); this.refresh(); });
      const drop = button('ed.discardDraft', () => { writeDraft(null); this.setNotice(null); });
      this.banner.append(msg, take, drop);
    } else {
      msg.textContent = t('ed.external');
      const take = button('ed.useFile', () => { this.base = n.text; this.ta.value = n.text; this.setNotice(null); this.refresh(); });
      const keep = button('ed.keepMine', () => { this.base = n.text; this.setNotice(null); this.refresh(); });
      this.banner.append(msg, take, keep);
    }
  }

  close() {
    if (this.dirty && !confirm(t('ed.confirmDiscard'))) return;
    writeDraft(null);
    // Hiding does not always move the focus off the textarea, and keys typed into a field are not shortcuts: Space would not start a take
    this.ta.blur();
    this.root.hidden = true;
    this.onClose?.();
  }

  async save() {
    const text = this.ta.value;
    try {
      await this.onSave(text);
      this.base = text;
      writeDraft(null);
      this.setNotice(null);
      this.refresh();
      this.toast?.(t('ed.saved'));
    } catch (e) {
      this.toast?.(t('ed.saveFailed', { msg: e.message }));
    }
  }

  /** script.md was changed outside the editor */
  external(text) {
    if (text === this.ta.value) { this.base = text; this.refresh(); return; }
    if (!this.dirty) {
      this.base = text;
      this.ta.value = text;
      this.refresh();
      this.toast?.(t('ed.reloaded'));
      return;
    }
    this.setNotice({ kind: 'external', text });
  }

  /** The interface language changed: rebuild the text made here */
  relang() {
    if (!this.isOpen) return;
    this.renderBanner();
    this.render();
  }

  refresh() {
    if (this.dirty) writeDraft(this.ta.value);
    this.render();
  }

  render() {
    const parsed = parseScript(this.ta.value, this.aliasMap);
    const stats = this.getStats() || {};
    const wpm = stats.wpm || {};
    const { per, total } = estimate(parsed, wpm);
    const target = parsed.targetSec;
    const over = !!target && total > target;
    const vars = { time: fmtSec(total), target: target ? fmtSec(target) : '' };
    this.est.textContent = t(target ? 'est.totalTarget' : 'est.total', vars) + (this.dirty ? t('ed.unsaved') : '');
    this.est.classList.toggle('over', over);
    this.wpm.textContent = parsed.speakers.map((s) => {
      const n = stats.samples?.[s]?.length || 0;
      return n
        ? t('ed.wpmMeasured', { name: s, wpm: Math.round(wpm[s]), n })
        : t('ed.wpmDefault', { name: s, wpm: DEFAULT_WPM });
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
      who.textContent = b.speaker || t('ed.noSpeaker');
      head.append(who);
      if (b.title) head.append(` · ${b.title}`);
      const sec = document.createElement('span');
      sec.className = 'ed-sec';
      sec.textContent = t('ed.sec', { s: per[i].toFixed(1) });
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
