// Every piece of text the page shows, in English and Chinese. English is the default; the sound check page has a toggle.
// The choice is kept in localStorage "tp.settings" as uiLang ('en' or 'zh').
//   t(key, vars)    the text for the current language; "{name}" is filled from vars. A missing key comes back as the key itself.
//                   A var may be { key, vars } to translate it too (so bound text re-translates fully on a switch).
//   applyDom()      fills [data-i18n] text, [data-i18n-title] titles and [data-i18n-placeholder] placeholders.
//   bind(el, key)   shows t(key) in el and keeps it translated when the language changes.
//   setLang(lang)   switches, saves, re-fills the page and fires a 'langchange' event on document (detail.lang),
//                   so app.js can re-render the text it builds itself.
// Both tables must have the same keys (test/docs.test.mjs checks). No other file under public/ may contain CJK text.

export const STRINGS = {
  en: {
    'app.title': 'Teleprompter',

    // Ready bar (prompter, before a take)
    'hint.click': 'Click to start',
    'hint.wheel': 'Wheel to preview',
    'hint.sim': ' · Simulation: no microphone, no recording',
    'btn.edit': 'Edit script E',
    'btn.setup': 'Sound check M',

    // Estimate
    'est.total': 'Estimate {time}',
    'est.totalTarget': 'Estimate {time} / {target}',
    'est.script': 'Script estimate {time}',
    'est.scriptTarget': 'Script estimate {time} / {target}',

    // Sound check page
    'setup.title': 'Sound check',
    'setup.intro': 'Get seated, then check the picture, the sound and the recognition before you start.',
    'setup.uiLang': 'Interface language',
    'setup.openMedia': 'Open camera and microphone',
    'setup.reopenMedia': 'Reopen camera and microphone',
    'setup.camera': 'Camera',
    'setup.mic': 'Microphone',
    'setup.sound': 'Sound',
    'setup.meterNote': 'The line is the speech threshold. When you talk, the bar should pass it clearly and turn green.',
    'setup.calibrate': 'Calibrate noise floor (stay quiet for 3 s)',
    'setup.calibrating': 'Stay quiet for 3 seconds…',
    'setup.floor': 'Noise floor {floor} dB, speech threshold {th} dB',
    'setup.recognition': 'Recognition',
    'setup.lang': 'Language',
    'setup.srNote': 'Each speaker reads their own first sentence. Recognition uses the system default microphone and needs internet.',
    'setup.fontSize': 'Text size',
    'setup.done': 'Done — start prompting',

    'media.error': 'Cannot open camera or microphone: {msg}',
    'media.info': 'Video {w}×{h} @{fps}fps · Recording format {mime}',
    'media.noRecorder': 'This browser cannot record',

    // Recognition test
    'sr.test': 'Test recognition',
    'sr.stopTest': 'Stop test',
    'sr.nothing': '(nothing heard yet)',
    'sr.quote': '"{text}"',
    'sr.matched': '{n}/{m} matched',
    'sr.listening': 'Listening',
    'sr.stopped': 'Stopped',
    'sr.network': 'No network for recognition',
    'sr.denied': 'Microphone or recognition blocked',
    'sr.noMic': 'No microphone',
    'sr.unsupported': 'This browser has no speech recognition. Use Chrome.',

    // Toasts
    'toast.scriptChanged': 'script.md changed; the prompter is updated',
    'toast.networkWheel': 'No network for recognition — use the wheel for now',
    'toast.deniedWheel': 'Microphone or recognition blocked — use the wheel for now',
    'toast.openMediaFirst': 'Open the camera and microphone first',
    'toast.openMicFirst': 'Open the microphone first',
    'toast.recNotStarted': 'Recording did not start: {msg}',
    'toast.discardSaved': 'Discarded take saved as {file}',
    'toast.discardNotSaved': 'Discarded take was not saved: {msg}',

    'rv.saving': 'Saving…',

    // Review page
    'rv.simFile': 'Simulation, not saved',
    'rv.notSaved': 'not saved',
    'rv.auto': 'auto stop',
    'rv.manual': 'manual stop',
    'rv.missed': '{n} words not matched',
    'rv.skipped': '{n} skipped with the wheel',
    'rv.saveError': 'Save error: {msg}',
    'rv.uploadFailed': 'Upload broke off; a full copy was saved to your Downloads folder',
    'rv.open': 'Open takes folder',
    'rv.setup': 'Back to sound check M',
    'rv.back': 'Back to prompter',
    'rv.red': 'Red',
    'rv.redMeans': ' = not matched (usually misheard; a long red run may be a real slip) · ',
    'rv.yellow': 'Yellow',
    'rv.yellowMeans': ' = skipped with the wheel · ',
    'rv.grey': 'Grey',
    'rv.greyMeans': ' = not reached · ',
    'rv.clickBack': 'Click empty space to go back to the prompter',

    // Server codes (server.mjs answers with these instead of text)
    'err.E_NO_FFMPEG': "ffmpeg not found; kept the browser's own file",
    'err.E_FFMPEG_FAILED': "ffmpeg could not convert it; kept the browser's own file",
    'err.E_FFMPEG_FAILED.detail': "ffmpeg could not convert it; kept the browser's own file ({detail})",
    'err.E_GONE': 'The server no longer has the video file of this take',
    'err.E_ORIGIN': 'The server refused the request. Open the page at http://localhost',
    'err.E_OPEN_FOLDER': 'Could not open the takes folder',
    'err.E_BAD_ID': 'Unknown take',
    'err.E_BAD_OFFSET': 'Bad upload position',
    'err.E_OFFSET': 'Upload out of step with the server',
    'err.server': 'Server returned {status}',
    'err.createTake': 'The server could not create this take',
    'err.saveFailed': 'Save failed',

    // Editor
    'ed.title': 'Edit script',
    'ed.save': 'Save Ctrl+S',
    'ed.close': 'Close Esc',
    'ed.unsaved': ' (unsaved)',
    'ed.wpmMeasured': '{name} {wpm} wpm ({n} takes measured)',
    'ed.wpmDefault': '{name} {wpm} wpm (default)',
    'ed.sec': '{s} s',
    'ed.noSpeaker': '(no speaker)',
    'ed.draft': 'Unsaved draft from {time} ',
    'ed.restoreDraft': 'Restore draft',
    'ed.discardDraft': 'Discard draft',
    'ed.external': 'script.md changed outside the page ',
    'ed.useFile': 'Use the file',
    'ed.keepMine': 'Keep mine',
    'ed.confirmDiscard': 'Discard unsaved changes?',
    'ed.saved': 'Saved to script.md',
    'ed.saveFailed': 'Save failed: {msg}',
    'ed.reloaded': 'script.md changed outside; loaded the new version',

    // Mouse and keyboard table (shortcuts.js → README)
    'sc.col.mouse': 'Mouse',
    'sc.col.key': 'Key',
    'sc.col.when': 'When',
    'sc.col.action': 'Action',
    'sc.in.click': 'Click on empty space',
    'sc.in.holdLeft': 'Hold the left button {s} s',
    'sc.in.holdRight': 'Hold the right button {s} s',
    'sc.in.rightClick': 'Right click',
    'sc.in.wheel': 'Wheel',
    'sc.when.always': 'Any time, except in the editor',
    'sc.sep': ', ',
    'key.Space': 'Space',
    'state.setup': 'Sound check',
    'state.ready': 'Before a take',
    'state.countdown': 'Countdown',
    'state.recording': 'Recording',
    'state.review': 'Review',
    'state.editor': 'Editor',
    'sc.start': 'Start a take (3 s countdown)',
    'sc.toReady': 'Back to the prompter',
    'sc.step': 'One phrase back or forward',
    'sc.stop': 'Stop and save the take',
    'sc.discard': 'Discard the take and restart the countdown',
    'sc.cancel': 'Cancel the countdown',
    'sc.next': 'Next phrase',
    'sc.prev': 'Previous phrase',
    'sc.editor': 'Open the script editor',
    'sc.setup': 'Open the sound check',
    'sc.fontUp': 'Bigger text',
    'sc.fontDown': 'Smaller text',
    'sc.fullscreen': 'Full screen on / off',
    'sc.save': 'Save the script',
    'sc.close': 'Close the editor',
  },

  zh: {
    'app.title': '提词器',

    'hint.click': '左键单击开始',
    'hint.wheel': '滚轮预览',
    'hint.sim': ' · 模拟模式：不开麦、不录像',
    'btn.edit': '改稿 E',
    'btn.setup': '试音 M',

    'est.total': '预计 {time}',
    'est.totalTarget': '预计 {time} / {target}',
    'est.script': '稿子预计 {time}',
    'est.scriptTarget': '稿子预计 {time} / {target}',

    'setup.title': '试音',
    'setup.intro': '两人坐好后在这里确认画面、声音和识别，然后进入提词。',
    'setup.uiLang': '界面语言',
    'setup.openMedia': '打开摄像头和麦克风',
    'setup.reopenMedia': '重新打开摄像头和麦克风',
    'setup.camera': '摄像头',
    'setup.mic': '麦克风',
    'setup.sound': '声音',
    'setup.meterNote': '竖线是「算在说话」的阈值。说话时条要明显越过竖线、变绿。',
    'setup.calibrate': '标定底噪（保持安静 3 秒）',
    'setup.calibrating': '请保持安静 3 秒…',
    'setup.floor': '底噪 {floor} dB，说话阈值 {th} dB',
    'setup.recognition': '识别',
    'setup.lang': '语言',
    'setup.srNote': '两人各读一遍自己的第一句。识别用的是系统默认麦克风，要联网。',
    'setup.fontSize': '字号',
    'setup.done': '完成，进入提词',

    'media.error': '打不开摄像头或麦克风：{msg}',
    'media.info': '画面 {w}×{h} @{fps}fps · 录制格式 {mime}',
    'media.noRecorder': '这个浏览器不能录',

    'sr.test': '开始测试识别',
    'sr.stopTest': '停止测试',
    'sr.nothing': '（还没听到）',
    'sr.quote': '「{text}」',
    'sr.matched': '对上 {n}/{m}',
    'sr.listening': '正在听',
    'sr.stopped': '已停',
    'sr.network': '识别连不上网',
    'sr.denied': '麦克风或识别被拒绝',
    'sr.noMic': '没有麦克风',
    'sr.unsupported': '这个浏览器没有语音识别，请用 Chrome',

    'toast.scriptChanged': 'script.md 改过了，提词已更新',
    'toast.networkWheel': '识别连不上网，现在只能用滚轮',
    'toast.deniedWheel': '麦克风或识别被拒绝，现在只能用滚轮',
    'toast.openMediaFirst': '先打开摄像头和麦克风',
    'toast.openMicFirst': '先打开麦克风',
    'toast.recNotStarted': '没开始录：{msg}',
    'toast.discardSaved': '作废的这条存为 {file}',
    'toast.discardNotSaved': '作废的这条没存上：{msg}',

    'rv.saving': '保存中…',

    'rv.simFile': '模拟，没存盘',
    'rv.notSaved': '没存上',
    'rv.auto': '自动停',
    'rv.manual': '手动停',
    'rv.missed': '没对上 {n} 个词',
    'rv.skipped': '滚轮跳过 {n} 个',
    'rv.saveError': '保存出错：{msg}',
    'rv.uploadFailed': '上传断过，已另存一份到下载文件夹',
    'rv.open': '打开 takes 文件夹',
    'rv.setup': '回到试音 M',
    'rv.back': '回到提词',
    'rv.red': '红',
    'rv.redMeans': ' = 识别没对上（多半是识别听错，连成一片的才可能是真念错）　',
    'rv.yellow': '黄',
    'rv.yellowMeans': ' = 滚轮跳过　',
    'rv.grey': '灰',
    'rv.greyMeans': ' = 没读到　· ',
    'rv.clickBack': '单击空白处回到提词',

    'err.E_NO_FFMPEG': 'ffmpeg 没转成，留的是浏览器原文件（没找到 ffmpeg）',
    'err.E_FFMPEG_FAILED': 'ffmpeg 没转成，留的是浏览器原文件',
    'err.E_FFMPEG_FAILED.detail': 'ffmpeg 没转成，留的是浏览器原文件（{detail}）',
    'err.E_GONE': '服务器上已没有这条的录像文件',
    'err.E_ORIGIN': '服务器拒绝了这个请求。请用 http://localhost 打开页面',
    'err.E_OPEN_FOLDER': '打不开 takes 文件夹',
    'err.E_BAD_ID': '没有这一条',
    'err.E_BAD_OFFSET': '上传位置不对',
    'err.E_OFFSET': '上传和服务器对不上',
    'err.server': '服务器返回 {status}',
    'err.createTake': '服务器没建成这一条',
    'err.saveFailed': '保存失败',

    'ed.title': '改稿',
    'ed.save': '保存 Ctrl+S',
    'ed.close': '关闭 Esc',
    'ed.unsaved': '（未保存）',
    'ed.wpmMeasured': '{name} {wpm} 词/分（实测 {n} 条）',
    'ed.wpmDefault': '{name} {wpm} 词/分（默认）',
    'ed.sec': '{s} 秒',
    'ed.noSpeaker': '（没标说话人）',
    'ed.draft': '有一份 {time} 没保存的草稿 ',
    'ed.restoreDraft': '恢复草稿',
    'ed.discardDraft': '丢掉',
    'ed.external': 'script.md 在外面改过了 ',
    'ed.useFile': '用文件里的版本',
    'ed.keepMine': '保留我的',
    'ed.confirmDiscard': '有没保存的修改，放弃吗？',
    'ed.saved': '已保存到 script.md',
    'ed.saveFailed': '保存失败：{msg}',
    'ed.reloaded': 'script.md 在外面改过，已换成新版',

    'sc.col.mouse': '鼠标',
    'sc.col.key': '按键',
    'sc.col.when': '什么时候',
    'sc.col.action': '作用',
    'sc.in.click': '单击空白处',
    'sc.in.holdLeft': '按住左键 {s} 秒',
    'sc.in.holdRight': '按住右键 {s} 秒',
    'sc.in.rightClick': '右键单击',
    'sc.in.wheel': '滚轮',
    'sc.when.always': '随时（改稿页除外）',
    'sc.sep': '、',
    'key.Space': '空格',
    'state.setup': '试音页',
    'state.ready': '开录前',
    'state.countdown': '倒数时',
    'state.recording': '录制中',
    'state.review': '回看页',
    'state.editor': '改稿页',
    'sc.start': '开始录一条（倒数 3 秒）',
    'sc.toReady': '回到提词',
    'sc.step': '后退或前进一小段',
    'sc.stop': '停止并保存这一条',
    'sc.discard': '作废这一条，马上重新倒数',
    'sc.cancel': '取消倒数',
    'sc.next': '前进一小段',
    'sc.prev': '后退一小段',
    'sc.editor': '打开改稿',
    'sc.setup': '打开试音',
    'sc.fontUp': '字号加大',
    'sc.fontDown': '字号减小',
    'sc.fullscreen': '进入 / 退出全屏',
    'sc.save': '保存稿子',
    'sc.close': '关闭改稿',
  },
};

export const LANGS = ['en', 'zh'];
const HTML_LANG = { en: 'en', zh: 'zh-CN' };
const SETTINGS_KEY = 'tp.settings';

function savedLang() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}').uiLang === 'zh' ? 'zh' : 'en';
  } catch {
    return 'en'; // no localStorage (Node, private mode) or a broken entry
  }
}

let current = savedLang();

export const getLang = () => current;

/** The language tag for <html lang> and for date / time formatting: 'en' or 'zh-CN'. */
export const htmlLang = (lang = current) => HTML_LANG[lang] || HTML_LANG.en;

export const hasKey = (key, lang = current) => Object.hasOwn(STRINGS[lang] || {}, key);

/** The text for key in a given language (describeShortcuts and the docs use this). */
export function tl(lang, key, vars) {
  const table = STRINGS[lang] || STRINGS.en;
  if (!Object.hasOwn(table, key)) return key;
  const s = table[key];
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, name) => {
    if (!(name in vars)) return m;
    const v = vars[name];
    return String(v && typeof v === 'object' ? tl(lang, v.key, v.vars) : v);
  });
}

export const t = (key, vars) => tl(current, key, vars);

/** Text for a server code (E_GONE, E_FFMPEG_FAILED …). Unknown codes come back as they are. */
export function codeText(code, detail) {
  const key = `err.${code}`;
  if (!hasKey(key)) return code == null ? '' : String(code);
  return detail && hasKey(`${key}.detail`) ? t(`${key}.detail`, { detail }) : t(key);
}

/** Shows t(key, vars) in el and keeps it translated when the language changes. */
export function bind(el, key, vars) {
  el.dataset.i18n = key;
  if (vars) el.dataset.i18nVars = JSON.stringify(vars);
  else delete el.dataset.i18nVars;
  el.textContent = t(key, vars);
}

/** Shows text that is not translated (and ends an earlier bind on el). */
export function unbind(el, text) {
  delete el.dataset.i18n;
  delete el.dataset.i18nVars;
  el.textContent = text;
}

export function applyDom(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    let vars;
    try { vars = el.dataset.i18nVars ? JSON.parse(el.dataset.i18nVars) : undefined; } catch { vars = undefined; }
    el.textContent = t(el.dataset.i18n, vars);
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
}

export function setLang(lang) {
  if (!LANGS.includes(lang)) return;
  current = lang;
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    s.uiLang = lang;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch { /* private mode: the choice lasts until reload */ }
  if (typeof document === 'undefined') return;
  document.documentElement.lang = htmlLang();
  applyDom();
  document.dispatchEvent(new CustomEvent('langchange', { detail: { lang } }));
}
