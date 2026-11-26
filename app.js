/* English Music Lab — app.js
   Biblioteca local (IndexedDB) + sincronização opcional via Gist privado do GitHub.
   Player: YouTube IFrame API. Todos os tempos vêm do JSON do usuário; o site só
   aplica deslocamentos que o próprio usuário escolheu (ajuste geral e por frase). */
(() => {
'use strict';

/* ================= utilidades ================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ESC[c]);
const now = () => performance.now();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const isNum = v => typeof v === 'number' && isFinite(v);
const fmtClock = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const fmtSec = ms => (ms > 0 ? '+' : ms < 0 ? '−' : '±') + (Math.abs(ms) / 1000).toFixed(1).replace('.', ',') + ' s';
const fmtRate = r => String(+r.toFixed(2)).replace('.', ',') + '×';
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function hash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
function relDate(t) {
  if (!t) return 'nunca aberta';
  const d = (Date.now() - t) / 864e5;
  if (d < 1 / 24) return 'aberta agora';
  if (d < 1) return 'aberta hoje';
  if (d < 2) return 'aberta ontem';
  if (d < 30) return `aberta há ${Math.floor(d)} dias`;
  return 'aberta em ' + new Date(t).toLocaleDateString('pt-BR');
}
let toastT;
function toast(msg, kind = '') {
  const t = $('#toast'); t.textContent = msg; t.className = 'show ' + kind;
  clearTimeout(toastT); toastT = setTimeout(() => { t.className = ''; }, kind === 'err' ? 5000 : 3000);
}

/* ================= armazenamento local ================= */
const store = {
  _db: null,
  open() {
    if (!this._db) this._db = new Promise((res, rej) => {
      let r; try { r = indexedDB.open('english-music-lab', 1); } catch (e) { rej(e); return; }
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return this._db;
  },
  async get(k) { const d = await this.open(); return new Promise((res, rej) => { const q = d.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); },
  async set(k, v) { const d = await this.open(); return new Promise((res, rej) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); },
  async del(k) { const d = await this.open(); return new Promise((res, rej) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').delete(k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); },
};
const ls = {
  get(k, d) { try { const v = localStorage.getItem('eml.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('eml.' + k, JSON.stringify(v)); } catch (e) { /* sem espaço/privado */ } },
  del(k) { try { localStorage.removeItem('eml.' + k); } catch (e) { /* */ } },
};

let INDEX = { songs: {} };
const liveSongs = () => Object.values(INDEX.songs).filter(s => !s.deleted);
let saveIdxT;
function saveIndex(bump) {          // bump = mudança que deve ir para os outros aparelhos
  if (bump && S.meta) S.meta.updatedAt = Date.now();
  clearTimeout(saveIdxT);
  saveIdxT = setTimeout(() => { store.set('index', INDEX).catch(() => toast('Não consegui salvar neste navegador.', 'err')); }, 250);
  if (bump) Sync.schedule();
}

/* ================= leitura e validação do JSON ================= */
function parseLyricsJSON(raw) {
  let txt = String(raw || '').replace(/^﻿/, '').trim();
  const fence = txt.match(/^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/);
  if (fence) txt = fence[1].trim();
  if (!txt) throw new Error('Nenhum conteúdo JSON foi fornecido.');
  let d;
  try { d = JSON.parse(txt); } catch (e) { throw new Error('O arquivo não é um JSON válido.\n' + e.message); }
  if (!d || typeof d !== 'object' || !Array.isArray(d.lines) || !d.lines.length) throw new Error('O JSON precisa ter uma lista "lines" com pelo menos uma frase.');
  const errors = [], warns = [];
  d.lines.forEach((l, k) => {
    const n = 'Frase ' + (k + 1);
    if (!l || typeof l !== 'object') { errors.push(n + ': não é um objeto.'); return; }
    if (typeof l.text !== 'string') errors.push(n + ': falta "text".');
    if (!isNum(l.start_ms)) errors.push(n + ': "start_ms" ausente ou inválido.');
    if (!isNum(l.end_ms)) errors.push(n + ': "end_ms" ausente ou inválido.');
    else if (isNum(l.start_ms) && l.end_ms < l.start_ms) errors.push(n + ': "end_ms" é menor que "start_ms".');
    if (l.words != null && !Array.isArray(l.words)) errors.push(n + ': "words" deve ser uma lista.');
    if (Array.isArray(l.words)) l.words.forEach((w, j) => {
      if (!w || typeof w.text !== 'string' || !isNum(w.start_ms) || !isNum(w.end_ms)) errors.push(`${n}, palavra ${j + 1}: precisa de "text", "start_ms" e "end_ms".`);
    });
    if (l.chunks != null && !Array.isArray(l.chunks)) errors.push(n + ': "chunks" deve ser uma lista.');
    if (Array.isArray(l.chunks)) {
      l.chunks.forEach((c, j) => { if (!c || typeof c.en !== 'string') errors.push(`${n}, bloco ${j + 1}: falta "en".`); });
      if (l.chunks.length && l.ptOrder != null && !validOrder(l.ptOrder, l.chunks.length)) warns.push(n + ': "ptOrder" inválido — usei a ordem original dos blocos.');
    }
  });
  if (errors.length) throw new Error(errors.slice(0, 8).join('\n') + (errors.length > 8 ? `\n… e mais ${errors.length - 8} problema(s).` : ''));
  const noWords = d.lines.filter(l => !(Array.isArray(l.words) && l.words.length)).length;
  if (noWords) warns.push(`${noWords} frase(s) sem "words": nelas o destaque será por bloco.`);
  const noChunks = d.lines.filter(l => !(Array.isArray(l.chunks) && l.chunks.length)).length;
  if (noChunks) warns.push(`${noChunks} frase(s) sem "chunks": aparecem sem pronúncia/tradução.`);
  for (let k = 1; k < d.lines.length; k++) if (d.lines[k].start_ms < d.lines[k - 1].start_ms) { warns.push('As frases não estavam em ordem de tempo; foram ordenadas por "start_ms".'); break; }
  return { data: d, warns };
}
function validOrder(po, n) {
  return Array.isArray(po) && po.length === n && po.every(isNum) && [...po].sort((a, b) => a - b).every((v, i) => v === i);
}
const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');

/* liga cada palavra ao seu bloco: primeiro pelo texto, depois pelo tempo */
function mapWords(words, chunks) {
  if (!words.length) return [];
  if (chunks.length === 1) return words.map(() => 0);
  const cw = chunks.map(c => norm(c.en)), wn = words.map(w => norm(w.text));
  const total = cw.join('');
  if (total.length && total === wn.join('')) {
    const ends = []; let acc = 0;
    cw.forEach(s => { acc += s.length; ends.push(acc); });
    let pos = 0;
    return wn.map(s => {
      const mid = pos + Math.max(0, s.length - 1) / 2; pos += s.length;
      const k = ends.findIndex(e => mid < e);
      return k < 0 ? chunks.length - 1 : k;
    });
  }
  const timed = chunks.some(c => c.timed);
  if (!timed) return words.map(() => 0);
  return words.map(w => {
    const m = (w.start + w.end) / 2; let best = 0, bd = Infinity;
    chunks.forEach((c, k) => { if (!c.timed) return; const dd = m < c.start ? c.start - m : m > c.end ? m - c.end : 0; if (dd < bd) { bd = dd; best = k; } });
    return best;
  });
}

function prepare(d) {
  const src = [...d.lines].sort((a, b) => a.start_ms - b.start_ms);
  return src.map(l => {
    const start = l.start_ms, end = Math.max(l.end_ms, start + 1);
    const words = (Array.isArray(l.words) ? l.words : []).map(w => ({ text: w.text, start: w.start_ms, end: Math.max(w.end_ms, w.start_ms) }));
    let chunks = (Array.isArray(l.chunks) ? l.chunks : []).map(c => ({
      en: c.en || '', pron: c.pron || '', pt: c.pt || '',
      timed: isNum(c.start_ms) && isNum(c.end_ms) && c.end_ms > c.start_ms,
      start: c.start_ms, end: c.end_ms,
    }));
    const synthetic = !chunks.length;
    if (synthetic) chunks = [{ en: l.text, pron: '', pt: '', timed: true, start, end }];
    const wc = mapWords(words, chunks);
    chunks.forEach((c, k) => {          // bloco sem tempo próprio: usa as palavras dele
      if (c.timed) return;
      const ws = words.filter((w, j) => wc[j] === k);
      if (ws.length) { c.start = Math.min(...ws.map(w => w.start)); c.end = Math.max(...ws.map(w => w.end)); }
      else { c.start = start; c.end = end; }
    });
    const ptOrder = validOrder(l.ptOrder, chunks.length) ? l.ptOrder : chunks.map((_, k) => k);
    return { text: l.text, start, end, words, wc, chunks, ptOrder, synthetic,
      spaced: words.some(w => /\s/.test(w.text)),
      ipa: typeof l.ipa === 'string' ? l.ipa.trim() : '', note: typeof l.note === 'string' ? l.note.trim() : '' };
  });
}

function ytId(u) {
  u = (u || '').trim();
  if (/^[\w-]{11}$/.test(u)) return u;
  try {
    const x = new URL(/^https?:\/\//i.test(u) ? u : 'https://' + u);
    const h = x.hostname.replace(/^(www|m|music)\./, '');
    let id = null;
    if (h === 'youtu.be') id = x.pathname.split('/')[1];
    else if (h === 'youtube.com' || h === 'youtube-nocookie.com') {
      id = x.searchParams.get('v');
      if (!id) { const m = x.pathname.match(/\/(?:embed|shorts|live|v)\/([\w-]{11})/); if (m) id = m[1]; }
    }
    if (id && /^[\w-]{11}/.test(id)) return id.slice(0, 11);
  } catch (e) { /* */ }
  return null;
}

/* ================= player do YouTube ================= */
const P = { yt: null, ready: false, videoId: null, state: -1, rate: 1, base: 0, baseT: 0, lastRep: -1, shown: 0, guard: null, apiFailed: false };
const playing = () => P.state === 1;
function rawTime() { try { return P.yt.getCurrentTime() || 0; } catch (e) { return 0; } }
function resyncClock() { const r = rawTime(); P.base = r; P.baseT = now(); P.lastRep = r; P.shown = r; }
function videoTime() {                 // segundos, suavizado entre as atualizações do player
  if (!P.ready) return 0;
  const r = rawTime(), t = now();
  if (P.guard) {
    if (Math.abs(r - P.guard.target) < 0.5 || t > P.guard.until) { P.guard = null; P.lastRep = r; P.base = r; P.baseT = t; }
    else return P.guard.target + (playing() ? (t - P.guard.t0) / 1000 * P.rate : 0);
  }
  if (!playing() && P.held != null && Math.abs(r - P.held) < 0.5) return P.held;   // pausado logo após um salto
  if (r !== P.lastRep) { P.lastRep = r; P.base = r; P.baseT = t; }
  let est = playing() ? P.base + Math.min(1.2, (t - P.baseT) / 1000) * P.rate : r;
  if (playing() && est < P.shown && P.shown - est < 0.3) est = P.shown;
  P.shown = est;
  return est;
}
function seekTo(sec) {
  sec = Math.max(0, sec);
  try { P.yt.seekTo(sec, true); } catch (e) { return; }
  const t = now();
  P.guard = { target: sec, t0: t, until: t + 1500 };
  P.held = sec;
  P.base = sec; P.baseT = t; P.shown = sec;
}
async function ensurePlayer(videoId) {
  const timeout = new Promise(res => setTimeout(() => res('timeout'), 12000));
  const r = await Promise.race([window.YTP, timeout]);
  if (r === 'timeout' && !window.YT) {
    P.apiFailed = true;
    showPlayerMsg('Não foi possível carregar o player do YouTube. Verifique a internet (ou um bloqueador de anúncios) e recarregue a página.');
    return;
  }
  if (P.yt) {
    if (P.videoId !== videoId) { P.videoId = videoId; P.state = -1; try { P.yt.cueVideoById(videoId); } catch (e) { /* */ } }
    return;
  }
  P.videoId = videoId;
  await new Promise(res => {
    const vars = { playsinline: 1, rel: 0, modestbranding: 1, disablekb: 1, iv_load_policy: 3, cc_load_policy: 0, fs: 1 };
    if (/^https?:$/.test(location.protocol)) vars.origin = location.origin;
    P.yt = new YT.Player('yt', {
      videoId, playerVars: vars,
      events: {
        onReady: () => { P.ready = true; res(); },
        onStateChange: e => onState(e.data),
        onPlaybackRateChange: e => { P.rate = e.data; resyncClock(); renderSpeeds(); },
        onError: e => onPlayerError(e.data),
      },
    });
  });
}
function onState(st) {
  P.state = st; if (st === 1) P.held = null;
  resyncClock(); updatePlayBtn();
  if (!S.id) return;
  if (st === 1 || st === 5) {
    if (!S.rateApplied) {           // aplica a velocidade salva desta música
      S.rateApplied = true;
      const want = S.meta.rate || 1;
      if (Math.abs((P.yt.getPlaybackRate() || 1) - want) > 0.01) setRate(want, true);
    }
    checkDuration();
  }
  if (st === 1) { $('#playerMsg').hidden = true; S.playRequested = 0; }
}
function onPlayerError(code) {
  const msgs = {
    2: 'O link do YouTube parece inválido. Confira o endereço em “Editar”.',
    5: 'O navegador não conseguiu reproduzir este vídeo. Tente recarregar a página.',
    100: 'Vídeo não encontrado: pode ter sido removido ou ser privado. Troque o link em “Editar”.',
    101: 'O dono deste vídeo não permite que ele toque fora do YouTube. Troque por outra versão (por exemplo, um “lyric video” ou o áudio oficial) em “Editar”.',
    150: 'O dono deste vídeo não permite que ele toque fora do YouTube. Troque por outra versão (por exemplo, um “lyric video” ou o áudio oficial) em “Editar”.',
  };
  showPlayerMsg(msgs[code] || 'O YouTube informou um erro (' + code + ') ao tocar este vídeo.');
}
function showPlayerMsg(m) { const el = $('#playerMsg'); el.textContent = m; el.hidden = false; }
function checkDuration() {
  if (S.durChecked) return;
  let dur = 0; try { dur = P.yt.getDuration() * 1000; } catch (e) { /* */ }
  if (!dur) return;
  S.durChecked = true;
  const md = S.data && S.data.metadata && S.data.metadata.duration_ms;
  const el = $('#durNote');
  if (isNum(md) && md > 0 && Math.abs(dur - md) > 1500) {
    el.textContent = `O vídeo tem ${fmtClock(dur)} e o arquivo diz ${fmtClock(md)}: podem ser versões diferentes. Se a letra sair do tempo, use o ajuste geral abaixo.`;
    el.hidden = false;
  } else el.hidden = true;
}

/* ================= estado da tela de estudo ================= */
const S = { id: null, meta: null, data: null, lines: [], cur: -2, loop: null, sel: null, gapT: null, gapEnd: 0, gapTick: null,
  pin: null, fixI: null, fixT: 0, rateApplied: false, durChecked: false, listHold: 0, curEl: null, wEls: [], ckEls: [], playRequested: 0 };
const RATES = [0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1];
const off = () => (S.meta && S.meta.offsetMs) || 0;
const adj = i => (S.meta && S.meta.lineAdj && S.meta.lineAdj[i]) || 0;
const lyricMs = (i, vms) => vms + off() + adj(i);
const lineVideoMs = i => S.lines[i].start - off() - adj(i);

function findCur(vms) {
  let c = -1;
  for (let i = 0; i < S.lines.length; i++) if (lyricMs(i, vms) + 1 >= S.lines[i].start) c = i;
  if (S.pin) {
    if (now() > S.pin.until) S.pin = null;
    else if (c === S.pin.i - 1 || (S.pin.i === 0 && c === -1)) c = S.pin.i;
    else if (c === S.pin.i) S.pin = null;
  }
  return c;
}

/* ---- render: blocos e palavras ---- */
const ckCls = k => 'ck c' + (k % 2);
function enHTML(L, live) {
  if (L.words.length) {
    let html = '', open = -1;
    L.words.forEach((w, j) => {
      const k = L.wc[j];
      if (k !== open) { if (open >= 0) html += '</span>'; html += `<span class="${ckCls(k)}" data-k="${k}">`; open = k; }
      const m = w.text.match(/^(\s*)([\s\S]*?)(\s*)$/);
      html += esc(m[1]) + `<span class="w">${esc(m[2])}</span>` + esc(m[3]) + (!L.spaced && j < L.words.length - 1 ? ' ' : '');
    });
    return html + '</span>';
  }
  return L.chunks.map((c, k) => `<span class="${ckCls(k)}${live ? ' hk' : ''}" data-k="${k}">${esc(c.en)}</span>`).join(' ');
}
function rowHTML(L, field, order, live) {
  const parts = order.filter(k => L.chunks[k][field]).map(k => `<span class="${ckCls(k)}${live ? ' hk' : ''}" data-k="${k}">${esc(L.chunks[k][field])}</span>`);
  return parts.join('<span class="sep"> </span>');
}
function lineBlock(L, live) {
  const ids = L.chunks.map((_, k) => k);
  const pron = L.chunks.some(c => c.pron) ? `<p class="pron">${rowHTML(L, 'pron', ids, live)}</p>` : '';
  const pt = L.chunks.some(c => c.pt) ? `<p class="pt">${rowHTML(L, 'pt', L.ptOrder, live)}</p>` : '';
  return `<p class="en" lang="en">${enHTML(L, live)}</p>${pron}${pt}`;
}
function extrasHTML(L) {
  if (!L.ipa && !L.note) return '';
  return `<div class="extra">${L.ipa ? `<span class="ipa"><b>IPA</b>${esc(L.ipa)}</span>` : ''}${L.note ? `<span class="note"><b>Dica</b>${esc(L.note)}</span>` : ''}</div>`;
}
function renderStage() {
  const st = $('#stage'), n = S.lines.length, c = S.cur;
  let html = `<div class="stage-top"><span>${c >= 0 ? `Frase ${c + 1} de ${n}` : 'Antes da primeira frase'}</span><span class="loop-badge" id="loopBadge"></span></div>`;
  if (c >= 0) html += `<div class="cur" data-i="${c}" title="Toque para recomeçar esta frase">${lineBlock(S.lines[c], true)}${extrasHTML(S.lines[c])}</div>`;
  else {
    const ll = S.meta.lastLine;
    html += `<div class="cur intro">${ll > 0 && ll < n ? `<button class="btn" type="button" id="resumeBtn">Continuar da frase ${ll + 1}</button>` : 'Aperte play: a letra acompanha o vídeo sozinha.'}</div>`;
  }
  const nx = Math.max(0, c + 1);
  if (nx < n) html += `<div class="next" data-i="${nx}"><span class="lbl">${c < 0 ? 'Primeira frase' : 'A seguir'}</span>${lineBlock(S.lines[nx], false)}</div>`;
  else html += '<div class="next end"><span class="lbl">Fim da letra</span></div>';
  st.innerHTML = html;
  S.curEl = $('.cur', st);
  S.wEls = c >= 0 ? $$('.cur .en .w', st) : [];
  S.ckEls = c >= 0 ? $$('.cur .hk', st) : [];
  S.hl = {};
  renderLoopBadge();
}
function updateHighlight(vms) {
  if (S.cur < 0) return;
  const L = S.lines[S.cur], lt = lyricMs(S.cur, vms);
  for (let j = 0; j < S.wEls.length; j++) {
    const w = L.words[j], cls = lt >= w.end ? 'w done' : lt >= w.start ? 'w now' : 'w';
    if (S.wEls[j].className !== cls) S.wEls[j].className = cls;
  }
  for (const el of S.ckEls) {
    const ch = L.chunks[+el.dataset.k], s = lt >= ch.end ? 'done' : lt >= ch.start ? 'now' : 'todo';
    if (el.dataset.s !== s) el.dataset.s = s;
  }
}

/* ---- lista completa ---- */
function renderList() {
  $('#lyrics').innerHTML = S.lines.map((L, i) => {
    const en = L.chunks.map((c, k) => `<span class="${ckCls(k)}">${esc(c.en)}</span>`).join(' ');
    const ids = L.chunks.map((_, k) => k);
    const pron = L.chunks.some(c => c.pron) ? `<p class="pron">${rowHTML(L, 'pron', ids, false)}</p>` : '';
    const pt = L.chunks.some(c => c.pt) ? `<p class="pt">${rowHTML(L, 'pt', L.ptOrder, false)}</p>` : '';
    return `<li data-i="${i}"${adj(i) ? ' class="adj"' : ''}><span class="t">${fmtClock(lineVideoMs(i))}</span><div><p class="en" lang="en">${en}</p>${pron}${pt}</div></li>`;
  }).join('');
  S.liEls = $$('#lyrics li');
  fillLineSelect();
  markList(true);
}
function markList(force) {
  const L = S.loop, sel = S.sel;
  S.liEls.forEach((li, i) => {
    li.classList.toggle('cur', i === S.cur);
    li.classList.toggle('inloop', !!L && i >= L.a && i <= L.b);
    li.classList.toggle('sel', !!sel && sel.a === i);
  });
  const box = $('#lyrics'), li = S.liEls[Math.max(0, S.cur)];
  if (!li || (!force && now() < S.listHold)) return;
  if (box.scrollHeight <= box.clientHeight + 4) return;
  const target = li.offsetTop - box.clientHeight * 0.3;
  box.scrollTo({ top: Math.max(0, target), behavior: force ? 'auto' : 'smooth' });
}

/* ---- loop ---- */
function renderLoopBadge() {
  const b = $('#loopBadge'); if (!b) return;
  const L = S.loop;
  b.textContent = !L ? '' : L.a === L.b ? `Repetindo esta frase · ${L.count + 1}ª vez` : `Loop frases ${L.a + 1}–${L.b + 1} · ${L.count + 1}ª vez`;
}
function renderLoopStatus() {
  const L = S.loop, st = $('#loopStatus');
  $('#loopLineBtn').setAttribute('aria-pressed', String(!!L && L.a === L.b));
  $('#loopRangeBtn').setAttribute('aria-pressed', String((!!L && L.a !== L.b) || !!S.sel));
  document.body.classList.toggle('selecting', !!S.sel);
  st.classList.toggle('live', !!L || !!S.sel);
  if (S.sel) st.innerHTML = S.sel.a == null ? '<b>Toque na PRIMEIRA frase</b> do trecho, na letra.' : `Início: frase ${S.sel.a + 1}. <b>Agora toque na ÚLTIMA frase</b> do trecho.`;
  else if (!L) st.textContent = 'Loop desligado';
  else {
    const what = L.a === L.b ? `frase ${L.a + 1}` : `frases ${L.a + 1} a ${L.b + 1}`;
    const gap = S.gapT ? ` · <b>pausa: ${Math.max(0, Math.ceil((S.gapEnd - now()) / 1000))} s</b>` : '';
    st.innerHTML = `Repetindo ${what} · ${L.count} repetição(ões) feita(s)${gap}`;
  }
  renderLoopBadge();
  markList(false);
}
function cancelGap() {
  if (S.gapT) { clearTimeout(S.gapT); S.gapT = null; }
  if (S.gapTick) { clearInterval(S.gapTick); S.gapTick = null; }
}
/* fim do loop: o end_ms da frase; se a frase quase não tem duração no arquivo
   (ex.: vocalizações com tempo zero), usa o início real da frase seguinte, também do arquivo */
function loopEnd(i) {
  const L = S.lines[i];
  if (L.end - L.start >= 400) return L.end;
  const nx = S.lines[i + 1];
  if (nx) return Math.max(L.end, nx.start + adj(i + 1) - adj(i));
  return S.durMs ? Math.max(L.end, S.durMs) : L.end + 1000;
}
function loopCheck(vms) {
  const L = S.loop;
  if (!L || S.gapT || !playing()) return;
  if (lyricMs(L.b, vms) < loopEnd(L.b)) return;
  L.count++;
  const gap = (S.meta.gapS || 0) * 1000;
  if (gap > 0) {
    try { P.yt.pauseVideo(); } catch (e) { /* */ }
    S.gapEnd = now() + gap;
    S.gapT = setTimeout(() => { cancelGap(); seekLine(L.a); playVideo(); renderLoopStatus(); }, gap);
    S.gapTick = setInterval(renderLoopStatus, 250);
  } else seekLine(L.a);
  renderLoopStatus();
}
function stopLoop() { const wasGap = !!S.gapT; S.loop = null; cancelGap(); if (wasGap) playVideo(); }
function toggleLoopLine() {
  if (S.loop && S.loop.a === S.loop.b) stopLoop();
  else {
    const i = Math.max(0, S.cur);
    S.loop = { a: i, b: i, count: 0 }; S.sel = null;
    if (S.cur < 0) seekLine(0);
  }
  renderLoopStatus();
}
function toggleRange() {
  if (S.sel) { S.sel = null; }
  else if (S.loop && S.loop.a !== S.loop.b) stopLoop();
  else { S.sel = { a: null }; }
  renderLoopStatus();
}
function pickForRange(i) {
  if (S.sel.a == null) { S.sel.a = i; renderLoopStatus(); return; }
  const a = Math.min(S.sel.a, i), b = Math.max(S.sel.a, i);
  S.sel = null; S.loop = { a, b, count: 0 }; cancelGap();
  seekLine(a); renderLoopStatus();
}

/* ---- navegação ---- */
function seekLine(i) {
  if (!P.ready || !S.lines.length) return;
  i = clamp(i, 0, S.lines.length - 1);
  seekTo(lineVideoMs(i) / 1000 + 0.001);
  S.pin = { i, until: now() + 900 };
}
function moveTo(i) {
  i = clamp(i, 0, S.lines.length - 1);
  if (S.loop) {
    if (S.loop.a === S.loop.b) { S.loop.a = S.loop.b = i; S.loop.count = 0; }
    else if (i < S.loop.a || i > S.loop.b) { S.loop = null; toast('Loop de trecho desligado'); }
  }
  const wasGap = !!S.gapT; cancelGap();
  seekLine(i);
  if (wasGap) playVideo();
  renderLoopStatus();
}
function goLine(delta) {
  const cur = S.pin && now() <= S.pin.until ? S.pin.i : S.cur;
  const base = cur < 0 ? (delta > 0 ? -1 : 0) : cur;
  moveTo(base + delta);
}
function playVideo() {
  try { P.yt.playVideo(); } catch (e) { return; }
  const t = S.playRequested = now();
  setTimeout(() => { if (S.playRequested === t && !playing() && P.state !== 3) toast('Se não começar, toque uma vez no próprio vídeo (o navegador exige isso na primeira vez).'); }, 1800);
}
function togglePlay() {
  if (!P.ready) return;
  if (S.gapT) { cancelGap(); seekLine(S.loop.a); playVideo(); renderLoopStatus(); return; }
  if (playing() || P.state === 3) P.yt.pauseVideo(); else playVideo();
}
function updatePlayBtn() {
  $('#playIcon').setAttribute('d', playing() || P.state === 3 ? 'M6 4h4v16H6zM14 4h4v16h-4z' : 'M7 4v16l13-8z');
}

/* ---- velocidade ---- */
function renderSpeeds() {
  const r = P.ready ? (P.yt.getPlaybackRate() || 1) : (S.meta ? S.meta.rate || 1 : 1);
  $('#speeds').innerHTML = RATES.map(v => `<button type="button" data-rate="${v}" class="${Math.abs(v - r) < 0.01 ? 'on' : ''}">${fmtRate(v)}</button>`).join('');
}
function setRate(v, silent) {
  if (!P.ready) return;
  try { P.yt.setPlaybackRate(v); } catch (e) { return; }
  setTimeout(() => {
    const got = P.yt.getPlaybackRate() || 1;
    P.rate = got; resyncClock();
    if (Math.abs(got - v) > 0.01 && !silent) toast(`O YouTube não aceitou ${fmtRate(v)} neste vídeo; está em ${fmtRate(got)}.`);
    if (S.meta && Math.abs((S.meta.rate || 1) - got) > 0.001) { S.meta.rate = got; saveIndex(true); }
    renderSpeeds();
  }, 350);
}
function stepRate(dir) {
  const r = P.ready ? (P.yt.getPlaybackRate() || 1) : 1;
  let i = RATES.findIndex(v => v >= r - 0.001); if (i < 0) i = RATES.length - 1;
  if (Math.abs(RATES[i] - r) > 0.001 && dir < 0) i--;
  i = clamp(i + dir, 0, RATES.length - 1);
  setRate(RATES[i]); toast('Velocidade ' + fmtRate(RATES[i]));
}

/* ---- sincronização manual ---- */
function nudgeOffset(ms) {
  S.meta.offsetMs = Math.round((off() + ms));
  saveIndex(true); renderSync(); renderList(); S.cur = -2;
  toast('Ajuste geral: ' + fmtSec(S.meta.offsetMs));
}
function fixTarget() {
  const v = +$('#lfSel').value;
  if (v >= 0) return v;                       // frase escolhida na lista
  if (S.fixI == null || now() - S.fixT > 4000) S.fixI = S.cur;
  S.fixT = now();
  return S.fixI;
}
function markLineNow() {
  if (!P.ready) return;
  let i = +$('#lfSel').value;
  if (!(i >= 0)) { toast('Primeiro escolha, em “Frase a corrigir”, qual frase vai começar.'); $('.linefix').open = true; $('#lfSel').focus(); return; }
  const vms = videoTime() * 1000;
  const m = S.meta.lineAdj || (S.meta.lineAdj = {});
  const v = Math.round(S.lines[i].start - off() - vms);   // faz a frase começar exatamente agora
  if (v) m[i] = v; else delete m[i];
  saveIndex(true); renderList(); S.cur = -2;
  toast(`Frase ${i + 1} agora começa em ${(vms / 1000).toFixed(1).replace('.', ',')} s do vídeo`);
  if (i + 1 < S.lines.length) $('#lfSel').value = String(i + 1);
  renderSync();
}
function fillLineSelect() {
  const sel = $('#lfSel'), keep = sel.value;
  sel.innerHTML = '<option value="-1">Acompanhar a frase que está tocando</option>' + S.lines.map((L, i) =>
    `<option value="${i}">${i + 1}. ${esc(L.text.length > 42 ? L.text.slice(0, 42) + '…' : L.text)}${adj(i) ? ' •' : ''}</option>`).join('');
  sel.value = keep && +keep < S.lines.length ? keep : '-1';
}
function nudgeLine(ms) {
  const i = fixTarget(); if (i < 0) { toast('Toque play e espere a frase aparecer.'); return; }
  const m = S.meta.lineAdj || (S.meta.lineAdj = {});
  const v = Math.round((m[i] || 0) + ms);
  if (v) m[i] = v; else delete m[i];
  saveIndex(true); renderSync(); renderList(); S.cur = -2;
}
function renderSync() {
  $('#offVal').textContent = fmtSec(off());
  const sv = +$('#lfSel').value;
  const i = sv >= 0 ? sv : S.fixI != null && now() - S.fixT < 4000 ? S.fixI : S.cur;
  $('#lfLabel').textContent = i >= 0 ? `Frase ${i + 1}: “${S.lines[i].text.slice(0, 48)}${S.lines[i].text.length > 48 ? '…' : ''}”` : 'Nenhuma frase tocando agora';
  $('#lfVal').textContent = fmtSec(i >= 0 ? adj(i) : 0);
  const n = Object.keys(S.meta.lineAdj || {}).length;
  $('#adjCount').textContent = n ? `${n} frase(s) com correção própria (marcadas com • na letra).` : '';
  $('#adjClear').hidden = !n;
}

/* ================= abrir música / biblioteca ================= */
let raf = 0, lastLineSaveT = 0;
function frame() {
  if (!S.id) { raf = 0; return; }
  raf = requestAnimationFrame(frame);
  if (!P.ready) return;
  const vms = videoTime() * 1000;
  const c = findCur(vms);
  if (c !== S.cur) {
    S.cur = c; renderStage(); markList(false); renderSync();
    if (c >= 0 && c !== S.meta.lastLine) { S.meta.lastLine = c; clearTimeout(lastLineSaveT); lastLineSaveT = setTimeout(() => saveIndex(false), 1500); }
  }
  updateHighlight(vms);
  loopCheck(vms);
  const tl = fmtClock(vms);
  if (S.tl !== tl) { S.tl = tl; $('#timeLbl').textContent = tl + (S.durMs ? ' / ' + fmtClock(S.durMs) : ''); }
}

async function openSong(id) {
  const meta = INDEX.songs[id];
  if (!meta || meta.deleted) { location.hash = ''; return; }
  let data = await store.get('song:' + id).catch(() => null);
  if (!data && Sync.on) { try { data = await Sync.fetchSong(id); } catch (e) { /* */ } }
  if (!data) { toast('A letra desta música ainda não chegou a este aparelho. Sincronize e tente de novo.', 'err'); location.hash = ''; return; }
  Object.assign(S, { id, meta, data, lines: prepare(data), cur: -2, loop: null, sel: null, pin: null, fixI: null, rateApplied: false, durChecked: false, tl: '' });
  cancelGap();
  const md = data.metadata && data.metadata.duration_ms;
  S.durMs = isNum(md) && md > 0 ? md : 0;
  meta.lastOpened = Date.now(); saveIndex(false);
  $('#libraryView').hidden = true; $('#songView').hidden = false;
  $('#songTitle').textContent = meta.title || 'Sem título';
  $('#songArtist').textContent = meta.artist || '';
  document.title = (meta.title || 'Música') + ' · English Music Lab';
  $('#gapSel').value = String(meta.gapS || 0);
  $('#playerMsg').hidden = true; $('#durNote').hidden = true;
  $('#lfSel').innerHTML = '';
  renderList(); renderStage(); renderSync(); renderLoopStatus(); renderSpeeds(); updatePlayBtn();
  window.scrollTo(0, 0);
  await ensurePlayer(meta.videoId);
  if (S.id !== id) return;
  if (P.ready) { S.durChecked = false; resyncClock(); renderSpeeds(); }
  if (!raf) raf = requestAnimationFrame(frame);
}
function showLibrary() {
  if (S.id && P.ready) { try { P.yt.pauseVideo(); } catch (e) { /* */ } }
  S.id = null; S.meta = null; cancelGap();
  $('#songView').hidden = true; $('#libraryView').hidden = false;
  document.title = 'English Music Lab';
  renderLibrary();
}
function renderLibrary() {
  const q = norm($('#search').value);
  const all = liveSongs().sort((a, b) => (b.lastOpened || b.addedAt || 0) - (a.lastOpened || a.addedAt || 0));
  const list = q ? all.filter(s => norm((s.title || '') + (s.artist || '')).includes(q)) : all;
  $('#libEmpty').hidden = all.length > 0;
  $('#search').hidden = all.length === 0;
  $('#libGrid').innerHTML = list.map(s => `<button type="button" class="card" data-id="${esc(s.id)}">
      <span class="thumb" style="background-image:url('https://i.ytimg.com/vi/${esc(s.videoId)}/mqdefault.jpg')"></span>
      <span class="ci"><span class="ct">${esc(s.title || 'Sem título')}</span><span class="ca">${esc(s.artist || '')}</span>
      <span class="cm">${s.lineCount ? s.lineCount + ' frases · ' : ''}${relDate(s.lastOpened)}${s.offsetMs ? ' · ajuste ' + fmtSec(s.offsetMs) : ''}</span></span></button>`).join('')
    + (q && !list.length ? '<p class="hint">Nenhuma música encontrada.</p>' : '');
}
function route() {
  const m = location.hash.match(/^#song-([\w]+)$/);
  if (m && INDEX.songs[m[1]] && !INDEX.songs[m[1]].deleted) { if (S.id !== m[1]) openSong(m[1]); }
  else showLibrary();
}
function onIndexChanged() {      // chamado quando a sincronização trouxe novidades
  if (S.id) {
    const m = INDEX.songs[S.id];
    if (!m || m.deleted) { toast('Esta música foi excluída em outro aparelho.'); location.hash = ''; return; }
    if (m !== S.meta) {
      const dataChanged = m.dataHash !== S.meta.dataHash;
      S.meta = m;
      if (dataChanged) { const id = S.id; S.id = null; openSong(id); return; }
      $('#songTitle').textContent = m.title || 'Sem título'; $('#songArtist').textContent = m.artist || '';
      $('#gapSel').value = String(m.gapS || 0);
      renderSync(); renderList(); S.cur = -2;
    }
  } else renderLibrary();
}

/* ================= diálogo adicionar/editar ================= */
const F = { editId: null, parsed: null };
function openSongDialog(editId) {
  F.editId = editId || null; F.parsed = null;
  const m = editId ? INDEX.songs[editId] : null;
  $('#sdTitle').textContent = m ? 'Editar música' : 'Adicionar música';
  $('#fUrl').value = m ? 'https://www.youtube.com/watch?v=' + m.videoId : '';
  $('#fTitle').value = m ? m.title || '' : '';
  $('#fArtist').value = m ? m.artist || '' : '';
  $('#fFile').value = ''; $('#fPaste').value = ''; $('#fFileName').textContent = 'Escolher arquivo…';
  $('#fJsonLabel').textContent = m ? 'Substituir o JSON da letra (opcional)' : 'Arquivo JSON da letra';
  $('#fInfo').hidden = true; $('#fErr').hidden = true;
  $('#fDelete').hidden = !m; $('#fDelete').textContent = 'Excluir música'; $('#fDelete').dataset.confirm = '';
  $('#songDialog').showModal();
  if (!m) setTimeout(() => $('#fUrl').focus(), 50);
}
function showParsed(txt, label) {
  $('#fErr').hidden = true;
  try {
    const p = parseLyricsJSON(txt);
    F.parsed = p;
    const md = p.data.metadata || {};
    if (md.title && !$('#fTitle').value.trim()) $('#fTitle').value = md.title;
    if (md.artist && !$('#fArtist').value.trim()) $('#fArtist').value = md.artist;
    const nl = p.data.lines.length, nw = p.data.lines.reduce((a, l) => a + ((l.words || []).length), 0);
    $('#fInfo').innerHTML = `<b>${esc(label)}</b>: ${nl} frases, ${nw} palavras com tempo${isNum(md.duration_ms) ? ', ' + fmtClock(md.duration_ms) : ''}.`
      + (p.warns.length ? '<ul>' + p.warns.map(w => `<li>${esc(w)}</li>`).join('') + '</ul>' : '');
    $('#fInfo').hidden = false;
  } catch (e) {
    F.parsed = null; $('#fInfo').hidden = true;
    $('#fErr').textContent = e.message; $('#fErr').hidden = false;
  }
}
async function saveSongDialog() {
  const err = m => { $('#fErr').textContent = m; $('#fErr').hidden = false; };
  const vid = ytId($('#fUrl').value);
  if (!vid) return err('Não reconheci o link do YouTube. Cole o endereço completo do vídeo (youtube.com/watch?v=… ou youtu.be/…).');
  if (!F.parsed && $('#fPaste').value.trim()) showParsed($('#fPaste').value, 'JSON colado');
  if (!$('#fErr').hidden) return;
  const m0 = F.editId ? INDEX.songs[F.editId] : null;
  if (!m0 && !F.parsed) return err('Escolha o arquivo JSON da letra (ou cole o conteúdo).');
  const t = Date.now();
  const meta = m0 || { id: uid(), addedAt: t, offsetMs: 0, lineAdj: {}, rate: 1, gapS: 0, lastLine: 0, lastOpened: 0 };
  meta.videoId = vid;
  meta.title = $('#fTitle').value.trim() || (F.parsed && F.parsed.data.metadata && F.parsed.data.metadata.title) || meta.title || 'Sem título';
  meta.artist = $('#fArtist').value.trim();
  if (F.parsed) {
    const json = JSON.stringify(F.parsed.data);
    const h = hash(json);
    if (h !== meta.dataHash) {
      await store.set('song:' + meta.id, F.parsed.data);
      if (m0 && m0.lineCount !== F.parsed.data.lines.length) meta.lineAdj = {};
      meta.dataHash = h; meta.lineCount = F.parsed.data.lines.length; meta.lastLine = 0;
    }
  }
  meta.updatedAt = t;
  INDEX.songs[meta.id] = meta;
  await store.set('index', INDEX);
  Sync.schedule();
  $('#songDialog').close();
  toast(m0 ? 'Música atualizada' : 'Música adicionada à biblioteca');
  if (m0 && S.id === meta.id) { S.id = null; openSong(meta.id); }
  else location.hash = 'song-' + meta.id;
}
async function deleteSong(id) {
  const m = INDEX.songs[id]; if (!m) return;
  INDEX.songs[id] = { id, deleted: true, updatedAt: Date.now() };
  await store.del('song:' + id).catch(() => {});
  await store.set('index', INDEX);
  Sync.schedule();
  $('#songDialog').close();
  toast('“' + (m.title || 'Música') + '” foi excluída');
  location.hash = '';
}

/* ================= sincronização (Gist privado) ================= */
const INDEX_FILE = 'english-music-lab.json';
const Sync = {
  token: ls.get('token', ''), gistId: ls.get('gistId', ''), pushed: ls.get('pushed', {}),
  last: ls.get('lastSync', 0), busy: false, again: false, timer: 0, err: '',
  get on() { return !!(this.token && this.gistId); },
  async api(path, opt = {}) {
    let r;
    try {
      r = await fetch('https://api.github.com' + path, Object.assign({}, opt, { cache: 'no-store', headers: Object.assign({
        Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + this.token,
      }, opt.body ? { 'Content-Type': 'application/json' } : {}) }));
    } catch (e) { throw new Error('Sem conexão com o GitHub.'); }
    if (!r.ok) {
      const e = new Error(r.status === 401 ? 'O token foi recusado (inválido ou expirado).'
        : r.status === 403 || r.status === 404 ? 'Acesso negado: o token precisa da permissão “gist”.'
          : 'O GitHub respondeu com erro ' + r.status + '.');
      e.status = r.status; throw e;
    }
    return r.status === 204 ? null : r.json();
  },
  async fileText(f) {
    if (!f) return null;
    if (!f.truncated && typeof f.content === 'string') return f.content;
    const r = await fetch(f.raw_url, { cache: 'no-store' });
    if (!r.ok) throw new Error('Não consegui baixar um arquivo do Gist.');
    return r.text();
  },
  async connect(token) {
    this.token = token.trim();
    let found = null;
    for (let page = 1; page <= 10 && !found; page++) {
      const list = await this.api(`/gists?per_page=100&page=${page}`);
      found = list.find(g => g.files && g.files[INDEX_FILE]);
      if (list.length < 100) break;
    }
    if (!found) found = await this.api('/gists', { method: 'POST', body: JSON.stringify({
      description: 'English Music Lab — biblioteca (não apague)', public: false,
      files: { [INDEX_FILE]: { content: JSON.stringify({ songs: {} }) } } }) });
    this.gistId = found.id; this.pushed = {};
    ls.set('token', this.token); ls.set('gistId', this.gistId); ls.set('pushed', {});
    await this.sync(true);
    if (this.err) throw new Error(this.err);
  },
  disconnect() {
    this.token = ''; this.gistId = ''; this.pushed = {}; this.err = '';
    ['token', 'gistId', 'pushed', 'lastSync'].forEach(k => ls.del(k));
    renderSyncChip();
  },
  schedule() { if (!this.on) return; clearTimeout(this.timer); this.timer = setTimeout(() => this.sync(), 2500); renderSyncChip(true); },
  async fetchSong(id) {
    const g = await this.api('/gists/' + this.gistId);
    const txt = await this.fileText(g.files['song-' + id + '.json']);
    if (!txt) return null;
    const d = JSON.parse(txt); await store.set('song:' + id, d); return d;
  },
  async sync(throwIt) {
    if (!this.on) return;
    if (this.busy) { this.again = true; return; }
    this.busy = true; renderSyncChip(true);
    try {
      const g = await this.api('/gists/' + this.gistId);
      const remote = JSON.parse((await this.fileText(g.files[INDEX_FILE])) || '{"songs":{}}');
      const rs = remote.songs || {};
      let changed = false, needPush = false;
      for (const [id, r] of Object.entries(rs)) {
        const l = INDEX.songs[id];
        if (!l || (r.updatedAt || 0) > (l.updatedAt || 0)) {
          if (!r.deleted) {
            const haveData = l && l.dataHash === r.dataHash && await store.get('song:' + id);
            if (!haveData) {
              const f = g.files['song-' + id + '.json'];
              if (!f) continue;
              await store.set('song:' + id, JSON.parse(await this.fileText(f)));
            }
          } else await store.del('song:' + id).catch(() => {});
          INDEX.songs[id] = Object.assign({}, r, { lastOpened: Math.max(r.lastOpened || 0, (l && l.lastOpened) || 0) });
          if (!r.deleted) this.pushed[id] = r.dataHash;
          changed = true;
        } else if ((r.updatedAt || 0) < (l.updatedAt || 0)) needPush = true;
        else if (!r.deleted && g.files['song-' + id + '.json']) this.pushed[id] = r.dataHash;
      }
      for (const id of Object.keys(INDEX.songs)) if (!rs[id]) needPush = true;
      if (changed) { await store.set('index', INDEX); onIndexChanged(); }
      if (needPush) await this.push(g);
      ls.set('pushed', this.pushed);
      this.last = Date.now(); ls.set('lastSync', this.last); this.err = '';
    } catch (e) {
      this.err = e.message || String(e);
      if (throwIt) { this.busy = false; renderSyncChip(); throw e; }
    }
    this.busy = false; renderSyncChip(); renderSyncDialog();
    if (this.again) { this.again = false; this.sync(); }
  },
  async push(g) {
    const files = { [INDEX_FILE]: { content: JSON.stringify(INDEX) } };
    for (const m of Object.values(INDEX.songs)) {
      const name = 'song-' + m.id + '.json';
      if (m.deleted) { if (g.files[name]) files[name] = null; continue; }
      if (!g.files[name] || this.pushed[m.id] !== m.dataHash) {
        const d = await store.get('song:' + m.id);
        if (d) files[name] = { content: JSON.stringify(d) };
      }
    }
    await this.api('/gists/' + this.gistId, { method: 'PATCH', body: JSON.stringify({ files }) });
    Object.values(INDEX.songs).forEach(m => { if (!m.deleted) this.pushed[m.id] = m.dataHash; else delete this.pushed[m.id]; });
  },
};
function renderSyncChip(busy) {
  const c = $('#syncBtn');
  c.classList.toggle('on', Sync.on && !Sync.err);
  c.classList.toggle('busy', !!(Sync.on && (busy || Sync.busy)));
  c.classList.toggle('bad', !!(Sync.on && Sync.err && !Sync.busy));
  $('#syncLabel').textContent = !Sync.on ? 'Só neste aparelho' : Sync.err ? 'Erro na sincronização' : (busy || Sync.busy) ? 'Sincronizando…' : 'Sincronizado';
}
function renderSyncDialog() {
  const on = Sync.on;
  $('#syncOff').hidden = on; $('#syncOn').hidden = !on;
  $('#syncConnect').hidden = on; $('#syncNow').hidden = !on; $('#syncDisconnect').hidden = !on;
  if (on) $('#syncState').innerHTML = Sync.err ? `<b>Problema:</b> ${esc(Sync.err)}`
    : `Conectado. ${liveSongs().length} música(s) na biblioteca. Última sincronização: ${Sync.last ? new Date(Sync.last).toLocaleString('pt-BR') : '—'}.`;
  $('#syncErr').hidden = true;
}

/* ================= backup ================= */
async function exportBackup() {
  const songs = {};
  for (const m of liveSongs()) songs[m.id] = await store.get('song:' + m.id);
  const blob = new Blob([JSON.stringify({ app: 'english-music-lab', version: 1, exportedAt: new Date().toISOString(), index: INDEX, songs })], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'english-music-lab-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
async function importBackup(file) {
  let b;
  try { b = JSON.parse(await file.text()); } catch (e) { toast('Este arquivo não é um backup válido.', 'err'); return; }
  if (!b || b.app !== 'english-music-lab' || !b.index || !b.songs) { toast('Este arquivo não é um backup do English Music Lab.', 'err'); return; }
  let n = 0;
  for (const [id, m] of Object.entries(b.index.songs || {})) {
    const l = INDEX.songs[id];
    if (m.deleted || !b.songs[id]) continue;
    if (!l || (m.updatedAt || 0) > (l.updatedAt || 0) || l.deleted) {
      await store.set('song:' + id, b.songs[id]);
      INDEX.songs[id] = Object.assign({}, m, { updatedAt: Date.now() }); n++;
    }
  }
  await store.set('index', INDEX); Sync.schedule(); onIndexChanged();
  toast(n ? `${n} música(s) importada(s)` : 'Nada novo neste backup');
}

/* ================= eventos ================= */
function bind() {
  window.addEventListener('hashchange', route);
  $('#addBtn').addEventListener('click', () => openSongDialog());
  document.addEventListener('click', e => {
    const a = e.target.closest('[data-act]');
    if (a && a.dataset.act === 'add') openSongDialog();
    if (a && a.dataset.act === 'back') location.hash = '';
    const cl = e.target.closest('[data-close]');
    if (cl) cl.closest('dialog').close();
  });
  $('#search').addEventListener('input', renderLibrary);
  $('#libGrid').addEventListener('click', e => { const c = e.target.closest('.card'); if (c) location.hash = 'song-' + c.dataset.id; });

  // diálogo música
  $('#fFile').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    $('#fFileName').textContent = f.name;
    showParsed(await f.text(), f.name);
  });
  $('#fPaste').addEventListener('input', () => { F.parsed = null; $('#fInfo').hidden = true; $('#fErr').hidden = true; });
  $('#fPaste').addEventListener('blur', () => { if ($('#fPaste').value.trim()) showParsed($('#fPaste').value, 'JSON colado'); });
  $('#songForm').addEventListener('submit', e => { e.preventDefault(); saveSongDialog(); });
  $('#fDelete').addEventListener('click', e => {
    const b = e.currentTarget;
    if (b.dataset.confirm) deleteSong(F.editId);
    else { b.dataset.confirm = '1'; b.textContent = 'Toque de novo para confirmar a exclusão'; }
  });
  $('#editSongBtn').addEventListener('click', () => openSongDialog(S.id));

  // sync
  $('#syncBtn').addEventListener('click', () => { renderSyncDialog(); $('#tokenIn').value = ''; $('#syncDialog').showModal(); });
  $('#syncConnect').addEventListener('click', async () => {
    const t = $('#tokenIn').value.trim();
    const er = $('#syncErr');
    if (!t) { er.textContent = 'Cole o token do GitHub.'; er.hidden = false; return; }
    const b = $('#syncConnect'); b.disabled = true; b.textContent = 'Conectando…';
    try { await Sync.connect(t); renderSyncDialog(); toast('Sincronização ativada'); }
    catch (e) { Sync.disconnect(); er.textContent = e.message; er.hidden = false; }
    b.disabled = false; b.textContent = 'Conectar';
  });
  $('#syncNow').addEventListener('click', async () => { await Sync.sync(); renderSyncDialog(); if (!Sync.err) toast('Biblioteca sincronizada'); });
  $('#syncDisconnect').addEventListener('click', () => { Sync.disconnect(); renderSyncDialog(); toast('Este aparelho não sincroniza mais (as músicas continuam salvas aqui).'); });
  $('#exportBtn').addEventListener('click', exportBackup);
  $('#importIn').addEventListener('change', e => { const f = e.target.files[0]; if (f) importBackup(f); e.target.value = ''; });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') Sync.sync(); });
  setInterval(() => { if (document.visibilityState === 'visible') Sync.sync(); }, 120000);

  // estudo
  $('#playBtn').addEventListener('click', togglePlay);
  $('#prevBtn').addEventListener('click', () => goLine(-1));
  $('#nextBtn').addEventListener('click', () => goLine(1));
  $('#loopLineBtn').addEventListener('click', toggleLoopLine);
  $('#loopRangeBtn').addEventListener('click', toggleRange);
  $('#gapSel').addEventListener('change', e => { S.meta.gapS = +e.target.value; saveIndex(true); });
  $('#speeds').addEventListener('click', e => { const b = e.target.closest('[data-rate]'); if (b) setRate(+b.dataset.rate); });
  $$('[data-off]').forEach(b => b.addEventListener('click', () => nudgeOffset(+b.dataset.off)));
  $('#offReset').addEventListener('click', () => { S.meta.offsetMs = 0; saveIndex(true); renderSync(); renderList(); S.cur = -2; });
  $$('[data-lf]').forEach(b => b.addEventListener('click', () => nudgeLine(+b.dataset.lf)));
  $('#lfReset').addEventListener('click', () => { const i = fixTarget(); if (i >= 0 && S.meta.lineAdj) { delete S.meta.lineAdj[i]; saveIndex(true); renderSync(); renderList(); S.cur = -2; } });
  $('#lfSel').addEventListener('change', e => { renderSync(); e.target.blur(); });
  $('#lfNow').addEventListener('click', markLineNow);
  $('#adjClear').addEventListener('click', () => { S.meta.lineAdj = {}; saveIndex(true); renderSync(); renderList(); S.cur = -2; toast('Correções por frase removidas'); });
  $('#lyrics').addEventListener('click', e => {
    const li = e.target.closest('li[data-i]'); if (!li) return;
    const i = +li.dataset.i;
    if (S.sel) pickForRange(i); else moveTo(i);
  });
  ['wheel', 'touchmove', 'pointerdown'].forEach(ev => $('#lyrics').addEventListener(ev, () => { S.listHold = now() + 4000; }, { passive: true }));
  $('#stage').addEventListener('click', e => {
    if (e.target.closest('#resumeBtn')) { moveTo(S.meta.lastLine); return; }
    const el = e.target.closest('[data-i]'); if (el) moveTo(+el.dataset.i);
  });

  // exibição
  const applyView = () => {
    const fs = ls.get('fs', 1);
    document.documentElement.style.setProperty('--fs', fs);
    const hp = ls.get('hidePron', false), ht = ls.get('hidePt', false);
    document.body.classList.toggle('hide-pron', hp); document.body.classList.toggle('hide-pt', ht);
    $('#togPron').setAttribute('aria-pressed', String(!hp)); $('#togPt').setAttribute('aria-pressed', String(!ht));
  };
  $('#fsDown').addEventListener('click', () => { ls.set('fs', Math.max(0.7, +(ls.get('fs', 1) - 0.1).toFixed(2))); applyView(); });
  $('#fsUp').addEventListener('click', () => { ls.set('fs', Math.min(1.8, +(ls.get('fs', 1) + 0.1).toFixed(2))); applyView(); });
  $('#togPron').addEventListener('click', () => { ls.set('hidePron', !ls.get('hidePron', false)); applyView(); });
  $('#togPt').addEventListener('click', () => { ls.set('hidePt', !ls.get('hidePt', false)); applyView(); });
  applyView();

  // teclado
  document.addEventListener('keydown', e => {
    if (!S.id || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return;
    if (document.querySelector('dialog[open]')) return;
    const k = e.key;
    if (k === ' ' || k === 'Spacebar') togglePlay();
    else if (k === 'ArrowLeft') goLine(-1);
    else if (k === 'ArrowRight') goLine(1);
    else if (k === 'ArrowUp') stepRate(1);
    else if (k === 'ArrowDown') stepRate(-1);
    else if (k === 'l' || k === 'L') toggleLoopLine();
    else if (k === 't' || k === 'T') toggleRange();
    else if (k === 'r' || k === 'R') moveTo(Math.max(0, S.cur));
    else if (k === 'm' || k === 'M') markLineNow();
    else if (k === '[') nudgeOffset(-100);
    else if (k === ']') nudgeOffset(100);
    else if (k === '{') nudgeOffset(-500);
    else if (k === '}') nudgeOffset(500);
    else if (k === 'Escape' && S.sel) { S.sel = null; renderLoopStatus(); }
    else return;
    e.preventDefault();
  });
  // depois de clicar no vídeo, devolve o foco à página para os atalhos continuarem funcionando
  window.addEventListener('blur', () => setTimeout(() => {
    const a = document.activeElement;
    if (a && a.tagName === 'IFRAME' && S.id) a.blur();
  }, 150));
}

/* ================= início ================= */
async function init() {
  bind();
  try { INDEX = (await store.get('index')) || { songs: {} }; }
  catch (e) { toast('Este navegador não permite salvar dados (modo privado?). A biblioteca não ficará guardada.', 'err'); }
  if (!INDEX.songs) INDEX.songs = {};
  renderSyncChip();
  route();
  if (Sync.on) Sync.sync();
}
init();
})();
