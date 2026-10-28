'use strict';
/*
 * Friend Monopoly server.
 * One process holds every room in memory. The TV page creates a room, phones join it with a
 * 4-letter code, and the server is the single source of truth: every change is pushed to every
 * screen as a fresh snapshot.
 *
 * Built the same way as Friend Feud, Friend Jeopardy and Friend Wheel: the same join flow, the
 * same reconnect and restart-survival tricks. The game is the banker, so there is no host: the
 * TV computer picks the board, the cards and how the game ends, and every phone plays.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const Boards = require('./boards');
const Cards = require('./cards');

const PORT = process.env.PORT || 3000;
const PUB = __dirname;
// Only the page files are ever handed to a browser.
const PAGE_FILES = new Set(['index.html', 'tv.html', 'common.js', 'boards.js', 'editor.js', 'style.css', 'anton.woff2']);
// Walkthrough videos get unlisted pages of their own (none yet). See Friend Jeopardy for how.
const PROMOS = {};
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.json': 'application/json', '.mp3': 'audio/mpeg'
};

// A fingerprint of the pages as they are right now, so a screen left open across an update reloads itself.
const BUILD = (() => {
  const h = crypto.createHash('sha1');
  for (const f of ['index.html', 'tv.html', 'common.js', 'boards.js', 'editor.js', 'style.css']) {
    try { h.update(fs.readFileSync(path.join(PUB, f))); } catch (e) { /* missing file: nothing to add */ }
  }
  return h.digest('hex').slice(0, 12);
})();

/* ---------------------------------------------------------------- rules */

const START_CASH = 1500;
const GO_PAY = 200;
const JAIL_FINE = 50;
const JAIL_MAX_TURNS = 3;              // the third failed roll pays the fine and moves
const BANK_HOUSES = 32;
const BANK_HOTELS = 12;
const MORTGAGE_INTEREST = 0.1;         // paid on top when lifting a mortgage, or on receiving a mortgaged property
const MAX_PLAYERS = 8;
const MIN_PLAYERS = 2;
const PIECES = ['🌮', '👟', '🎮', '🚀', '🌵', '🍩', '🛹', '🦖'];   // the quick picks; any single emoji works
const BOT_NAMES = ['PENNY', 'BUCK', 'NICKEL', 'DIME', 'GRAND', 'CENT', 'BILL', 'QUID'];
const BOT_PIECES = ['🤖', '👾', '🛸', '🦾', '🧠', '📟', '🎰', '🪙'];
const BOT_MS = 1400;                   // a bot thinks this long before it does anything
const AUCTION_CHOICES = [10, 15, 20, 30];
const COLORS = 8;                      // the eight player colors, by index (the pages hold the swatches)
const ADD_TIME_CHOICES = [5, 10, 15, 30];
const PHOTO_MAX = 60000;               // a photo piece: a small square image the phone has already shrunk
const MINUTE_CHOICES = [30, 45, 60, 90, 120];
const TURN_CHOICES = [0, 30, 60, 90];  // a clock to roll, buy or settle a debt (0 = no clock)

const MOVE_STEP_MS = 170;              // the token hops one space in this long on the TV
const MOVE_EXTRA_MS = 700;
const TELEPORT_MS = 1400;              // a card sending you somewhere
const CARD_MS = 4200;                  // a card stays up this long before it does its thing
const PAUSE_MS = 2600;                 // the end of a move stays up this long before the next turn
const ROLLOFF_MS = 4200;
const IDLE_MS = 25000;                 // a player whose phone dropped is played for after this
const SPEED = Number(process.env.SPEED_UP) || 1;   // tests run the clocks faster
const ROOM_IDLE_MS = 6 * 60 * 60 * 1000;

// Surviving a restart: the TV keeps a sealed copy of its room and hands it back if it ever
// reconnects to a server that has forgotten it (see packRoom and restoreRoom). The same sealed
// copy, kept on purpose, is a saved game that can be picked up another night.
const BOOT = Date.now();
const RESTORE_WINDOW_MS = Number(process.env.RESTORE_WINDOW_MS) || 10 * 60 * 1000;
const RESTORE_GRACE_MS = 5000;
const SEAT_HOLD_MS = Number(process.env.SEAT_HOLD_MS) || 30000;
const STRAGGLER_MS = Number(process.env.STRAGGLER_MS) || 3 * 60 * 1000;
const BACKUP_V = 1;
const BACKUP_DELAY_MS = 200;
const BACKUP_MAX = 380 * 1024;
const BACKUP_KEY = (() => {
  let seed = process.env.BACKUP_KEY || process.env.RENDER_SERVICE_ID;
  if (!seed) {
    const file = path.join(__dirname, '.backup-key');
    try { seed = fs.readFileSync(file, 'utf8').trim(); } catch (e) { /* first run */ }
    if (!seed) {
      seed = crypto.randomBytes(32).toString('hex');
      try { fs.writeFileSync(file, seed + '\n', { mode: 0o600 }); } catch (e) { /* read-only disk */ }
    }
  }
  return crypto.createHash('sha256').update('friend-monopoly room backup|' + seed).digest();
})();

const DEFAULT_SETTINGS = { theme: 'classic', deck: 'classic', mode: 'timer', minutes: 60, turnSecs: 0, auctionSecs: 15 };
const rooms = new Map();

/* ------------------------------------------------------------------ http */

const server = http.createServer((req, res) => {
  let u;
  try { u = new URL(req.url, 'http://localhost'); } catch (e) { res.writeHead(400); return res.end(); }
  let p;
  try { p = decodeURIComponent(u.pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (p === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  if (p === '/version') { res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); return res.end(BUILD); }
  if (p === '/uptime') {
    res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    return res.end('started ' + new Date(BOOT).toISOString() + ' · up ' + Math.round((Date.now() - BOOT) / 1000) + 's');
  }
  if (p === '/qr.svg') {
    const text = (u.searchParams.get('u') || '').slice(0, 300);
    return QRCode.toString(text || ' ', { type: 'svg', margin: 1, errorCorrectionLevel: 'L' }, (err, svg) => {
      if (err) { res.writeHead(500); return res.end(); }
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=3600' });
      res.end(svg);
    });
  }
  const ph = /^\/photo\/([A-Z]{4})\/([\w-]{1,20})$/.exec(p);
  if (ph) {
    const room = rooms.get(ph[1]), pl = room && room.players.get(ph[2]);
    const m = pl && pl.photo && /^data:(image\/[a-z]+);base64,(.*)$/.exec(pl.photo);
    if (!m) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    const body = Buffer.from(m[2], 'base64');
    res.writeHead(200, { 'content-type': m[1], 'content-length': body.length, 'cache-control': 'public, max-age=86400, immutable', 'x-content-type-options': 'nosniff' });
    return res.end(body);
  }
  const promo = Object.keys(PROMOS).find(base => p === base || p.startsWith(base + '/'));
  if (promo) return sendPromo(req, res, promo, p.slice(promo.length).replace(/\/$/, ''));
  if (p === '/') p = '/index.html';
  if (p === '/tv') p = '/tv.html';
  const rel = p.replace(/^\/+/, '');
  if (!PAGE_FILES.has(rel)) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
  const file = path.join(PUB, rel);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    const ext = path.extname(file);
    if (ext === '.html') data = Buffer.from(String(data).replace('<html lang="en">', '<html lang="en" data-build="' + BUILD + '">'));
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.woff2' ? 'public, max-age=604800' : 'no-cache'
    });
    res.end(data);
  });
});

// A walkthrough video page and its two files, sent in pieces so iPhones will play it.
function sendPromo(req, res, base, sub) {
  const P = PROMOS[base];
  const entry = { '': ['promo.html', 'text/html; charset=utf-8'], '/video.mp4': [P.video, 'video/mp4'], '/poster.jpg': [P.poster, 'image/jpeg'] }[sub];
  const gone = () => { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found'); };
  if (!entry || (req.method !== 'GET' && req.method !== 'HEAD')) return gone();
  const file = path.join(PUB, entry[0]), type = entry[1];
  const head = { 'content-type': type, 'x-robots-tag': 'noindex, nofollow' };
  if (sub === '') {
    return fs.readFile(file, 'utf8', (err, html) => {
      if (err) return gone();
      const host = /^[a-z0-9.:-]+$/i.test(req.headers.host || '') ? req.headers.host : 'localhost';
      const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim() === 'https' ? 'https' : 'http';
      const body = Buffer.from(html.split('{{HERE}}').join(proto + '://' + host + base).split('{{PATH}}').join(base).split('{{TITLE}}').join(P.title).split('{{HEAD}}').join(P.head));
      res.writeHead(200, Object.assign(head, { 'cache-control': 'no-cache', 'content-length': body.length }));
      res.end(req.method === 'HEAD' ? undefined : body);
    });
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return gone();
    let start = 0, end = st.size - 1, code = 200;
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      if (m[1] === '') start = Math.max(0, st.size - Number(m[2]));
      else { start = Number(m[1]); if (m[2]) end = Math.min(end, Number(m[2])); }
      if (start > end || start >= st.size) { res.writeHead(416, { 'content-range': 'bytes */' + st.size }); return res.end(); }
      code = 206;
      head['content-range'] = 'bytes ' + start + '-' + end + '/' + st.size;
    }
    res.writeHead(code, Object.assign(head, { 'content-length': end - start + 1, 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=86400' }));
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(file, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });
}

/* --------------------------------------------------------------- helpers */

const rid = (n = 12) => crypto.randomBytes(n).toString('base64url');
const die = () => crypto.randomInt(6) + 1;

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeCode() {
  const letters = 'BCDFGHJKLMNPQRSTVWXZ';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += letters[crypto.randomInt(letters.length)];
    if (!rooms.has(c)) return c;
  }
}

function clean(s, max) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// The boards the TV made up.
function cleanCustom(c) {
  const out = { boards: [] };
  if (!c || typeof c !== 'object') return out;
  const seen = new Set();
  for (const x of (Array.isArray(c.boards) ? c.boards.slice(0, 12) : [])) {
    const t = Boards.customTheme(x);
    if (t && !seen.has(t.id)) { seen.add(t.id); out.boards.push(t); }
  }
  return out;
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

// A piece is one emoji: a single grapheme that is a pictograph (flags and skin tones welcome).
const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('en', { granularity: 'grapheme' }) : null;
function cleanPiece(s) {
  s = String(s == null ? '' : s).trim();
  if (!s || s.length > 24) return null;
  const parts = segmenter ? [...segmenter.segment(s)].map(x => x.segment) : [s];
  if (parts.length !== 1) return null;
  const g = parts[0];
  if (!/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(g)) return null;
  if (/^[0-9#*]/.test(g) && g.length < 3) return null;
  return g;
}

const money = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');

/* ----------------------------------------------------------------- rooms */

function newRoom() {
  const room = {
    code: makeCode(),
    adminToken: rid(),
    touched: Date.now(),
    displays: new Set(),
    players: new Map(),
    order: [],            // players, in the order they joined: their seats
    settings: Object.assign({}, DEFAULT_SETTINGS),
    custom: { boards: [] },
    chats: {},            // private messages, by 'id|id' pair (ids sorted)
    game: null,
    fx: [],
    fxSeq: 0,
    timer: null,          // the one action clock (see armTimer)
    endTimer: null,       // the game clock in a timed game
    botTimer: null
  };
  rooms.set(room.code, room);
  return room;
}

function fx(room, type, data) {
  room.fx.push(Object.assign({ seq: ++room.fxSeq, type }, data || {}));
  if (room.fx.length > 16) room.fx.shift();
}

const pname = (room, id) => { const p = room.players.get(id); return p ? p.name : '?'; };
const seats = room => room.order.filter(id => room.players.has(id));
// The first player runs the lobby from their phone too (Start, Play again). Settings live on the TV.
const captainId = room => seats(room).find(id => !room.players.get(id).bot) || null;
const themeOf = room => Boards.themeById(room.settings.theme, room.custom.boards);
const spacesOf = room => room.game ? room.game.spaces : Boards.build(themeOf(room));

/* ---------------------------------------------------- surviving a restart */

function packRoom(room, lean, kind) {
  const data = {
    v: BACKUP_V, at: Date.now(), kind: kind || 'backup', code: room.code, adminToken: room.adminToken,
    players: [...room.players.values()].map(p => ({ id: p.id, token: p.token, name: p.name, piece: p.piece, color: p.color, photo: lean ? null : p.photo || null, bot: !!p.bot })),
    order: room.order, settings: room.settings, custom: room.custom, chats: lean ? {} : room.chats,
    game: room.game, fxSeq: room.fxSeq
  };
  if (room.game) data.timeLeft = room.game.endsAt ? Math.max(0, room.game.endsAt - Date.now()) : null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', BACKUP_KEY, iv);
  const body = Buffer.concat([c.update(zlib.deflateRawSync(JSON.stringify(data))), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

function unpackRoom(blob) {
  const raw = Buffer.from(String(blob), 'base64');
  if (raw.length < 30) throw new Error('too short');
  const d = crypto.createDecipheriv('aes-256-gcm', BACKUP_KEY, raw.subarray(0, 12), { authTagLength: 16 });
  d.setAuthTag(raw.subarray(12, 28));
  const body = Buffer.concat([d.update(raw.subarray(28)), d.final()]);
  return JSON.parse(zlib.inflateRawSync(body, { maxOutputLength: 16 * 1024 * 1024 }));
}

function sendBackup(room) {
  if (rooms.get(room.code) !== room) return;
  const to = [...room.displays].filter(ws => ws.admin && ws.readyState === 1);
  if (!to.length) return;
  let blob;
  try {
    blob = packRoom(room, false);
    if (blob.length > BACKUP_MAX) blob = packRoom(room, true);
  } catch (e) { return console.error('backup error', e); }
  if (blob.length > BACKUP_MAX) return;
  const msg = JSON.stringify({ t: 'backup', code: room.code, blob, info: saveInfo(room) });
  for (const ws of to) ws.send(msg);
}

function queueBackup(room) {
  if (room.backupTimer) return;
  room.backupTimer = setTimeout(() => { room.backupTimer = null; sendBackup(room); }, BACKUP_DELAY_MS);
}

// What a saved game looks like in the TV's list.
function saveInfo(room) {
  const g = room.game;
  return {
    at: Date.now(), players: seats(room).map(id => pname(room, id)), theme: themeOf(room).name,
    phase: g ? g.phase : 'lobby', turns: g ? g.turnCount || 0 : 0,
    alive: g ? seats(room).filter(id => g.players[id] && !g.players[id].bankrupt).length : 0,
    timeLeft: g && g.endsAt ? Math.max(0, g.endsAt - Date.now()) : null, mode: room.settings.mode
  };
}

function hydrateRoom(d, code, opts) {
  const room = {
    code, adminToken: opts.adminToken, touched: Date.now(), displays: new Set(), players: new Map(),
    order: d.order || [], settings: Object.assign({}, DEFAULT_SETTINGS, d.settings),
    custom: cleanCustom(d.custom), chats: d.chats && typeof d.chats === 'object' ? d.chats : {}, game: d.game, fx: [], fxSeq: (d.fxSeq || 0) + 50, timer: null, endTimer: null, botTimer: null
  };
  const hold = Date.now() + SEAT_HOLD_MS;
  for (const p of d.players) {
    if (p.bot) room.players.set(p.id, { id: p.id, token: p.token, name: p.name, piece: p.piece, color: p.color, bot: true, connected: true, ws: null, hold: 0, goneAt: 0 });
    else room.players.set(p.id, { id: p.id, token: opts.freshTokens ? rid() : p.token, name: p.name, piece: p.piece, color: p.color, connected: false, ws: null, hold: opts.freshTokens ? 0 : hold, goneAt: Date.now(), waitingFor: true });
  }
  for (const p of room.players.values()) if (!Number.isInteger(p.color)) p.color = freeColor(room);
  for (const x of d.players) { const p = room.players.get(x.id); if (p) setPhoto(p, cleanPhoto(x.photo)); }
  const g = room.game;
  if (g) {
    g.spaces = Boards.build(Boards.themeById(g.theme, room.custom.boards));
    if (g.endsAt && d.timeLeft != null) g.endsAt = Date.now() + d.timeLeft + RESTORE_GRACE_MS;
    if (g.clock) {
      // The clock stood still while the server was away: give it back its time, plus a moment to reconnect.
      const used = Math.max(0, Math.min(Number(opts.idle) || 0, 10 * 60 * 1000));
      g.clock.at = Date.now() + Math.max(0, g.clock.at - d.at - used) + RESTORE_GRACE_MS;
      if (opts.freshTokens) freshClock(room);
    }
  }
  return room;
}

function restoreRoom(blob, code, token, idle) {
  let d;
  try { d = unpackRoom(blob); } catch (e) { return null; }
  if (!d || d.v !== BACKUP_V || d.code !== code || !token || d.adminToken !== token) return null;
  if (!(Date.now() - d.at < ROOM_IDLE_MS) || rooms.has(code)) return null;
  const room = hydrateRoom(d, code, { adminToken: d.adminToken, idle });
  try { publicState(room); } catch (e) { console.error('restore error', e); return null; }
  rooms.set(code, room);
  armTimer(room); armEndTimer(room); scheduleBots(room);
  room.tidyTimer = setTimeout(() => {
    room.tidyTimer = null;
    if (rooms.get(code) !== room || room.game) return;
    let gone = 0;
    for (const p of [...room.players.values()]) if (!p.connected && !room.order.includes(p.id)) { room.players.delete(p.id); gone++; }
    if (gone) pushAll(room);
  }, STRAGGLER_MS);
  fx(room, 'restored');
  console.log('restored room ' + code + ' (' + room.players.size + ' players, ' + (room.game ? room.game.phase : 'lobby') + ')');
  return room;
}

// A saved game from another night comes back as a brand-new room. Everyone joins again with
// the same name and gets their seat back.
function loadRoom(blob) {
  let d;
  try { d = unpackRoom(blob); } catch (e) { return null; }
  if (!d || d.v !== BACKUP_V || !d.game) return null;
  const code = makeCode();
  const room = hydrateRoom(d, code, { adminToken: rid(), freshTokens: true });
  try { publicState(room); } catch (e) { console.error('load error', e); return null; }
  rooms.set(code, room);
  armTimer(room); armEndTimer(room); scheduleBots(room);
  fx(room, 'loaded');
  console.log('loaded saved game as room ' + code);
  return room;
}

/* ------------------------------------------------------------ the clock */

function clearTimer(room) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
}

function setClock(room, what, ms, show) {
  ms = Math.round(ms / SPEED);
  room.game.clock = { what, at: Date.now() + ms, len: ms, show: !!show };
  armTimer(room);
}
function stopClock(room) {
  if (room.game) room.game.clock = null;
  clearTimer(room);
}

// One action clock per room: whatever the game is waiting for next.
function armTimer(room) {
  clearTimer(room);
  const g = room.game;
  if (!g || !g.clock) return;
  const c = g.clock;
  room.timer = setTimeout(() => {
    room.timer = null;
    if (room.game !== g || g.clock !== c) return;
    g.clock = null;
    try { onClock(room, c.what); } catch (e) { console.error('clock error', e); }
    pushAll(room);
  }, Math.max(0, c.at - Date.now()));
}

function onClock(room, what) {
  const g = room.game;
  switch (what) {
    case 'rolloff': rolloffDone(room); break;
    case 'land': land(room); break;
    case 'card': applyCard(room); break;
    case 'next': nextTurn(room); break;
    case 'auction': auctionEnd(room); break;
    case 'auto': autoAct(room, true); break;
    case 'win': break;
  }
  void g;
}

// The game clock of a timed game.
function armEndTimer(room) {
  if (room.endTimer) { clearTimeout(room.endTimer); room.endTimer = null; }
  const g = room.game;
  if (!g || !g.endsAt || g.phase === 'gameOver') return;
  room.endTimer = setTimeout(() => {
    room.endTimer = null;
    if (room.game !== g || g.phase === 'gameOver') return;
    try { endGame(room, 'time'); } catch (e) { console.error('end error', e); }
    pushAll(room);
  }, Math.max(0, g.endsAt - Date.now()));
}

// The clock a phase starts with, for a game picked up again.
function freshClock(room) {
  const g = room.game;
  g.clock = null;
  switch (g.phase) {
    case 'rolloff': setClock(room, 'rolloff', ROLLOFF_MS); break;
    case 'moving': setClock(room, 'land', TELEPORT_MS); break;
    case 'card': setClock(room, 'card', CARD_MS); break;
    case 'pause': setClock(room, 'next', PAUSE_MS); break;
    case 'auction': setClock(room, 'auction', room.settings.auctionSecs * 1000, true); break;
    case 'turn': case 'buy': case 'debt': turnClock(room); break;
    default: armTimer(room);
  }
}

function turnClock(room) {
  const g = room.game, secs = room.settings.turnSecs;
  if (!secs) { stopClock(room); return; }
  setClock(room, 'auto', secs * 1000 * (g.phase === 'debt' ? 2 : 1), true);
}

/* ------------------------------------------------------------ the game */

const alive = (room, g) => seats(room).filter(id => g.players[id] && !g.players[id].bankrupt);
const P = (g, id) => g.players[id];

function log(room, text, kind, data) {
  const g = room.game;
  g.log.push(Object.assign({ n: ++g.logSeq, text, kind: kind || '' }, data || {}));
  if (g.log.length > 80) g.log.shift();
}

function startGame(room) {
  const ids = seats(room);
  if (ids.length < MIN_PLAYERS || ids.length > MAX_PLAYERS) return;
  const theme = themeOf(room);
  const deck = Cards.deckById(room.settings.deck);
  const players = {};
  for (const id of ids) players[id] = { cash: START_CASH, pos: 0, jail: false, jailTurns: 0, cards: { chance: false, chest: false }, bankrupt: false, out: 0, stats: { rent: 0, rentPaid: 0, jail: 0, doubles: 0, bought: 0 } };
  room.game = {
    phase: 'rolloff', theme: theme.id, deck: deck.id, mode: room.settings.mode,
    spaces: Boards.build(theme),
    players, order: ids.slice(), cur: null, roll: null, rolloff: null, turnCount: 0,
    props: {}, bank: { houses: BANK_HOUSES, hotels: BANK_HOTELS },
    decks: { chance: shuffle(deck.cards.chance.map((c, i) => i)), chest: shuffle(deck.cards.chest.map((c, i) => i)) },
    card: null, offer: null, auction: null, auctionQueue: [], debts: [], trades: [], tradeSeq: 0,
    next: null, landing: null, log: [], logSeq: 0, clock: null,
    endsAt: room.settings.mode === 'timer' ? Date.now() + room.settings.minutes * 60000 / SPEED : null,
    outCount: 0, ranking: null, winner: null, why: null
  };
  log(room, 'The game begins on the ' + theme.name + ' board. Everyone starts with ' + money(START_CASH) + '.', 'start');
  fx(room, 'start');
  rolloff(room, ids);
  armEndTimer(room);
}

/* -------- who goes first: everyone rolls, highest starts */

function rolloff(room, ids) {
  const g = room.game;
  const rolls = {};
  for (const id of ids) rolls[id] = [die(), die()];
  g.rolloff = { rolls, among: ids };
  g.phase = 'rolloff';
  fx(room, 'rolloff', { rolls });
  setClock(room, 'rolloff', ROLLOFF_MS);
}

function rolloffDone(room) {
  const g = room.game, r = g.rolloff;
  let top = 0;
  for (const id of r.among) top = Math.max(top, r.rolls[id][0] + r.rolls[id][1]);
  const tied = r.among.filter(id => r.rolls[id][0] + r.rolls[id][1] === top);
  if (tied.length > 1) return rolloff(room, tied);
  const first = tied[0], i = g.order.indexOf(first);
  g.order = g.order.slice(i).concat(g.order.slice(0, i));
  g.rolloff = null;
  log(room, pname(room, first) + ' rolled highest and goes first.', 'turn');
  g.cur = g.order[0];
  startTurn(room);
}

/* -------- turns */

function startTurn(room, again) {
  const g = room.game, id = g.cur;
  g.phase = 'turn'; g.roll = { n: again && g.roll ? g.roll.n : 0 }; g.next = null; g.landing = null; g.offer = null; g.card = null;
  g.turnCount++;
  fx(room, 'turn', { pid: id, jail: P(g, id).jail, again: !!again });
  turnClock(room);
}

function nextTurn(room) {
  const g = room.game;
  if (g.phase === 'gameOver') return;
  const live = alive(room, g);
  if (live.length <= 1) return endGame(room, 'last');
  // Properties of someone who left mid-move are auctioned before the next roll.
  if (g.auctionQueue.length && !g.auction) return startAuction(room, g.auctionQueue.shift(), 'bank');
  const me = P(g, g.cur);
  if (g.roll && g.roll.dbl && !me.jail && !me.bankrupt && live.includes(g.cur)) {
    log(room, pname(room, g.cur) + ' rolled doubles and goes again.', 'turn');
    return startTurn(room, true);
  }
  const i = g.order.indexOf(g.cur);
  for (let k = 1; k <= g.order.length; k++) {
    const id = g.order[(i + k) % g.order.length];
    if (live.includes(id)) { g.cur = id; break; }
  }
  startTurn(room);
}

function doRoll(room, p) {
  const g = room.game;
  if (!g || g.phase !== 'turn' || g.cur !== p.id) return;
  const me = P(g, p.id);
  if (me.jail) return jailRoll(room, p);
  const d1 = die(), d2 = die(), dbl = d1 === d2;
  g.roll = { d1, d2, dbl, n: g.roll.n + (dbl ? 1 : 0) };
  if (dbl) me.stats.doubles++;
  fx(room, 'roll', { pid: p.id, d1, d2, dbl });
  if (dbl && g.roll.n >= 3) {
    log(room, pname(room, p.id) + ' rolled doubles three times in a row. Straight to jail.', 'jail');
    goToJail(room, p.id);
    return done(room);
  }
  log(room, pname(room, p.id) + ' rolled ' + (d1 + d2) + (dbl ? ' (doubles)' : '') + '.', 'roll');
  move(room, p.id, d1 + d2, { kind: 'roll' });
}

// Walk `steps` spaces (or jump straight to `opts.to`). The TV animates it; the server lands the
// token when the hops are over.
function move(room, pid, steps, opts) {
  const g = room.game, me = P(g, pid);
  opts = opts || {};
  const from = me.pos;
  let to, passGo = false;
  if (opts.to != null) { to = opts.to; passGo = opts.collect && to <= from; steps = (to - from + 40) % 40; }
  else { to = ((from + steps) % 40 + 40) % 40; passGo = steps > 0 && from + steps >= 40; }
  me.pos = to;
  if (passGo && to !== 0) { me.cash += GO_PAY; log(room, pname(room, pid) + ' passes GO and collects ' + money(GO_PAY) + '.', 'go'); }
  g.phase = 'moving';
  g.landing = { pid, opts };
  const teleport = opts.to != null || steps < 0;
  fx(room, 'move', { pid, from, to, steps, passGo, teleport, back: steps < 0 });
  setClock(room, 'land', teleport ? TELEPORT_MS : MOVE_STEP_MS * Math.abs(steps) + MOVE_EXTRA_MS);
}

function land(room) {
  const g = room.game, L = g.landing;
  if (!L) return done(room);
  const pid = L.pid, opts = L.opts || {}, me = P(g, pid), sp = g.spaces[me.pos], name = pname(room, pid);
  g.landing = null;
  if (me.bankrupt) return done(room);
  switch (sp.t) {
    case 'go':
      me.cash += GO_PAY;
      log(room, name + ' lands on GO and collects ' + money(GO_PAY) + '.', 'go');
      fx(room, 'go', { pid });
      return done(room);
    case 'prop': case 'rail': case 'util': {
      const pr = g.props[sp.i];
      if (!pr) return offerBuy(room, pid, sp.i);
      if (pr.owner === pid) { log(room, name + ' lands on ' + sp.name + ', which they own.', 'land'); return done(room); }
      if (pr.m) { log(room, name + ' lands on ' + sp.name + '. It is mortgaged, so no rent.', 'land'); return done(room); }
      let dice = g.roll && g.roll.d1 ? g.roll.d1 + g.roll.d2 : 7;
      if (opts.utilDice) { const d1 = die(), d2 = die(); dice = d1 + d2; fx(room, 'roll', { pid, d1, d2, dbl: false, util: true }); log(room, name + ' rolls ' + dice + ' for the utility.', 'roll'); }
      const rent = rentFor(g, sp.i, dice, opts);
      log(room, name + ' lands on ' + sp.name + ' and owes ' + pname(room, pr.owner) + ' ' + money(rent) + ' rent.', 'rent');
      fx(room, 'rent', { pid, to: pr.owner, amount: rent, space: sp.i });
      me.stats.rentPaid += rent;
      charge(room, pid, pr.owner, rent, 'rent for ' + sp.name);
      return settle(room);
    }
    case 'tax':
      log(room, name + ' lands on ' + sp.name + ' and pays ' + money(sp.amount) + '.', 'tax');
      fx(room, 'tax', { pid, amount: sp.amount });
      charge(room, pid, 'bank', sp.amount, sp.name);
      return settle(room);
    case 'chance': return drawCard(room, pid, 'chance');
    case 'chest': return drawCard(room, pid, 'chest');
    case 'gotojail':
      log(room, name + ' lands on Go to Jail.', 'jail');
      goToJail(room, pid);
      return done(room);
    case 'jail':
      log(room, name + ' is just visiting jail.', 'land');
      return done(room);
    case 'parking':
      log(room, name + ' parks for free. Nothing happens.', 'land');
      return done(room);
  }
  return done(room);
}

// What landing on an owned space costs.
function rentFor(g, i, dice, opts) {
  const sp = g.spaces[i], pr = g.props[i], owner = pr.owner;
  opts = opts || {};
  const owned = Boards.members(sp.g).filter(k => g.props[k] && g.props[k].owner === owner).length;
  if (sp.t === 'rail') return 25 * Math.pow(2, owned - 1) * (opts.rentMult || 1);
  if (sp.t === 'util') return dice * (opts.utilDice ? 10 : owned === 2 ? 10 : 4);
  if (pr.h > 0) return sp.rent[pr.h];
  const monopoly = owned === Boards.members(sp.g).length;
  return sp.rent[0] * (monopoly ? 2 : 1);
}

// The move is over and nothing is owed: a short pause, then the next turn.
function done(room) {
  const g = room.game;
  if (g.phase === 'gameOver') return;
  g.phase = 'pause'; g.offer = null; g.next = null;
  setClock(room, 'next', PAUSE_MS);
}

// Pay now if you can, otherwise it's a debt to work off. Returns true when paid.
function charge(room, pid, to, amount, reason) {
  const g = room.game, me = P(g, pid);
  amount = Math.round(amount);
  if (amount <= 0) return true;
  if (me.cash >= amount) { pay(room, pid, to, amount); return true; }
  g.debts.push({ pid, to, amount, reason });
  fx(room, 'debt', { pid, amount, to });
  log(room, pname(room, pid) + " can't cover " + money(amount) + ' and has to raise it.', 'debt');
  return false;
}

function pay(room, from, to, amount) {
  const g = room.game;
  if (from) P(g, from).cash -= amount;
  if (to === 'each') {
    const others = alive(room, g).filter(id => id !== from);
    for (const id of others) P(g, id).cash += Math.round(amount / others.length);
  } else if (to && to !== 'bank') { P(g, to).cash += amount; P(g, to).stats.rent += amount; }
}

// Whatever is waiting: a debt to settle, an auction to run, then the move's continuation.
function settle(room) {
  const g = room.game;
  if (g.phase === 'gameOver') return;
  g.debts = g.debts.filter(d => !P(g, d.pid).bankrupt);
  if (g.debts.length) { g.phase = 'debt'; turnClock(room); return; }
  if (g.auction) return;
  if (g.auctionQueue.length) return startAuction(room, g.auctionQueue.shift(), 'bank');
  const n = g.next; g.next = null;
  if (n && n.k === 'jailMove' && !P(g, n.pid).bankrupt) {
    const me = P(g, n.pid);
    me.jail = false; me.jailTurns = 0;
    log(room, pname(room, n.pid) + ' pays the ' + money(JAIL_FINE) + ' fine and moves ' + (n.d1 + n.d2) + '.', 'jail');
    g.roll = { d1: n.d1, d2: n.d2, dbl: false, n: 0 };
    return move(room, n.pid, n.d1 + n.d2, { kind: 'roll' });
  }
  if (n && n.k === 'turn') { g.phase = 'turn'; turnClock(room); return; }
  done(room);
}

/* -------- buying and auctions */

function offerBuy(room, pid, i) {
  const g = room.game;
  g.phase = 'buy'; g.offer = { pid, space: i };
  fx(room, 'offer', { pid, space: i });
  turnClock(room);
}

function buy(room, p) {
  const g = room.game;
  if (!g || g.phase !== 'buy' || !g.offer || g.offer.pid !== p.id) return;
  const sp = g.spaces[g.offer.space], me = P(g, p.id);
  if (me.cash < sp.price) return send(p.ws, { t: 'error', msg: "You can't afford it. Raise the money first, or let it go to auction." });
  const before = fullSets(g, p.id);
  me.cash -= sp.price; me.stats.bought++;
  g.props[sp.i] = { owner: p.id, h: 0, m: false };
  log(room, pname(room, p.id) + ' buys ' + sp.name + ' for ' + money(sp.price) + '.', 'buy');
  fx(room, 'buy', { pid: p.id, space: sp.i });
  noteSets(room, p.id, before);
  g.offer = null;
  settle(room);
}

function decline(room, p) {
  const g = room.game;
  if (!g || g.phase !== 'buy' || !g.offer || g.offer.pid !== p.id) return;
  const i = g.offer.space;
  g.offer = null;
  log(room, pname(room, p.id) + ' passes on ' + g.spaces[i].name + '. It goes to auction.', 'auction');
  startAuction(room, i, 'declined');
}

function startAuction(room, i, reason) {
  const g = room.game;
  g.phase = 'auction';
  g.auction = { space: i, bid: 0, bidder: null, passed: [], reason, bids: 0 };
  fx(room, 'auction', { space: i, reason });
  setClock(room, 'auction', room.settings.auctionSecs * 1000, true);
}

function bid(room, p, amount) {
  const g = room.game, a = g && g.auction;
  if (!a || g.phase !== 'auction') return;
  const me = P(g, p.id);
  if (!me || me.bankrupt) return;
  amount = Math.round(Number(amount));
  if (!Number.isFinite(amount) || amount <= a.bid || amount < 1) return;
  if (amount > me.cash) return send(p.ws, { t: 'error', msg: 'You only have ' + money(me.cash) + ' on hand.' });
  a.bid = amount; a.bidder = p.id; a.bids++;
  a.passed = a.passed.filter(id => id !== p.id);
  fx(room, 'bid', { pid: p.id, amount });
  setClock(room, 'auction', room.settings.auctionSecs * 1000, true);
  checkAuction(room);
}

function passAuction(room, p) {
  const g = room.game, a = g && g.auction;
  if (!a || g.phase !== 'auction' || a.passed.includes(p.id) || a.bidder === p.id) return;
  a.passed.push(p.id);
  checkAuction(room);
}

function checkAuction(room) {
  const g = room.game, a = g.auction;
  const still = alive(room, g).filter(id => !a.passed.includes(id) && id !== a.bidder);
  if (!still.length) auctionEnd(room);
}

function auctionEnd(room) {
  const g = room.game, a = g.auction;
  if (!a) return;
  const sp = g.spaces[a.space];
  g.auction = null;
  if (a.bidder) {
    const me = P(g, a.bidder);
    const paid = Math.min(a.bid, me.cash), before = fullSets(g, a.bidder);
    me.cash -= paid; me.stats.bought++;
    g.props[sp.i] = { owner: a.bidder, h: 0, m: false };
    log(room, pname(room, a.bidder) + ' wins ' + sp.name + ' at auction for ' + money(paid) + '.', 'buy');
    fx(room, 'sold', { pid: a.bidder, space: sp.i, amount: paid });
    noteSets(room, a.bidder, before);
  } else {
    log(room, 'Nobody bids on ' + sp.name + '. It stays with the bank.', 'auction');
    fx(room, 'unsold', { space: sp.i });
  }
  stopClock(room);
  settle(room);
}

/* -------- Chance and Community Chest */

function cardText(room, c) {
  const g = room.game;
  return c.text.replace(/\{s(\d+)\}/g, (m, n) => g.spaces[Number(n)].name);
}

function drawCard(room, pid, which) {
  const g = room.game;
  const deck = Cards.deckById(g.deck).cards[which];
  if (!g.decks[which].length) g.decks[which] = shuffle(deck.map((c, i) => i).filter(i => deck[i].k !== 'jailfree' || !cardOut(g, which)));
  const idx = g.decks[which].shift();
  const c = deck[idx];
  if (c.k === 'jailfree') P(g, pid).cards[which] = true;
  else g.decks[which].push(idx);
  g.card = { which, idx, pid, k: c.k, text: cardText(room, c) };
  g.phase = 'card';
  log(room, pname(room, pid) + ' draws ' + (which === 'chance' ? 'Chance' : 'Community Chest') + ': ' + g.card.text, 'card');
  fx(room, 'card', { pid, which, text: g.card.text });
  setClock(room, 'card', CARD_MS);
}

const cardOut = (g, which) => Object.values(g.players).some(p => p.cards[which]);

function applyCard(room) {
  const g = room.game, cd = g.card;
  if (!cd) return done(room);
  const deck = Cards.deckById(g.deck).cards[cd.which], c = deck[cd.idx];
  const pid = cd.pid, me = P(g, pid), name = pname(room, pid);
  g.card = null;
  if (me.bankrupt) return done(room);
  switch (c.k) {
    case 'move': return move(room, pid, 0, { to: c.to, collect: true, kind: 'card' });
    case 'nearest': {
      let to = me.pos;
      for (let k = 1; k <= 40; k++) { const s = g.spaces[(me.pos + k) % 40]; if (s.t === c.kind) { to = s.i; break; } }
      return move(room, pid, 0, { to, collect: true, kind: 'card', rentMult: c.kind === 'rail' ? 2 : 1, utilDice: c.kind === 'util' });
    }
    case 'back': return move(room, pid, -c.n, { kind: 'back' });
    case 'jail': goToJail(room, pid); return done(room);
    case 'jailfree': return done(room);
    case 'collect': me.cash += c.n; fx(room, 'collect', { pid, amount: c.n }); return done(room);
    case 'pay': charge(room, pid, 'bank', c.n, 'the card'); return settle(room);
    case 'repairs': {
      let houses = 0, hotels = 0;
      for (const i of Object.keys(g.props)) { const pr = g.props[i]; if (pr.owner === pid) { if (pr.h === 5) hotels++; else houses += pr.h; } }
      const total = houses * c.house + hotels * c.hotel;
      log(room, name + ' owes ' + money(total) + ' for repairs (' + houses + ' houses, ' + hotels + ' hotels).', 'tax');
      charge(room, pid, 'bank', total, 'repairs');
      return settle(room);
    }
    case 'each': {
      for (const id of alive(room, g)) if (id !== pid) charge(room, id, pid, c.n, 'a gift for ' + name);
      return settle(room);
    }
    case 'payEach': {
      const others = alive(room, g).filter(id => id !== pid);
      charge(room, pid, 'each', c.n * others.length, 'paying everyone');
      return settle(room);
    }
  }
  return done(room);
}

/* -------- jail */

function goToJail(room, pid) {
  const g = room.game, me = P(g, pid);
  me.pos = 10; me.jail = true; me.jailTurns = 0; me.stats.jail++;
  if (g.roll) g.roll.dbl = false;
  fx(room, 'jail', { pid });
}

function jailRoll(room, p) {
  const g = room.game, me = P(g, p.id);
  const d1 = die(), d2 = die(), dbl = d1 === d2;
  fx(room, 'roll', { pid: p.id, d1, d2, dbl, jail: true });
  if (dbl) {
    me.jail = false; me.jailTurns = 0;
    g.roll = { d1, d2, dbl: false, n: 0 };
    log(room, pname(room, p.id) + ' rolls doubles and walks out of jail.', 'jail');
    fx(room, 'free', { pid: p.id });
    return move(room, p.id, d1 + d2, { kind: 'roll' });
  }
  me.jailTurns++;
  if (me.jailTurns >= JAIL_MAX_TURNS) {
    g.next = { k: 'jailMove', pid: p.id, d1, d2 };
    charge(room, p.id, 'bank', JAIL_FINE, 'the jail fine');
    return settle(room);
  }
  g.roll = { d1, d2, dbl: false, n: 0 };
  log(room, pname(room, p.id) + ' rolls ' + (d1 + d2) + ', no doubles. Still in jail (' + me.jailTurns + ' of ' + JAIL_MAX_TURNS + ').', 'jail');
  done(room);
}

function payJail(room, p) {
  const g = room.game, me = P(g, p.id);
  if (!g || g.phase !== 'turn' || g.cur !== p.id || !me.jail) return;
  if (me.cash < JAIL_FINE) return send(p.ws, { t: 'error', msg: 'You need ' + money(JAIL_FINE) + ' on hand.' });
  me.cash -= JAIL_FINE; me.jail = false; me.jailTurns = 0;
  log(room, pname(room, p.id) + ' pays ' + money(JAIL_FINE) + ' to get out of jail.', 'jail');
  fx(room, 'free', { pid: p.id });
}

function useJailCard(room, p) {
  const g = room.game, me = P(g, p.id);
  if (!g || g.phase !== 'turn' || g.cur !== p.id || !me.jail) return;
  const which = me.cards.chance ? 'chance' : me.cards.chest ? 'chest' : null;
  if (!which) return;
  me.cards[which] = false; me.jail = false; me.jailTurns = 0;
  const deck = Cards.deckById(g.deck).cards[which];
  const idx = deck.findIndex(c => c.k === 'jailfree');
  if (idx >= 0) g.decks[which].push(idx);
  log(room, pname(room, p.id) + ' uses a Get Out of Jail Free card.', 'jail');
  fx(room, 'free', { pid: p.id });
}

/* -------- houses, hotels and mortgages (any time during the game) */

const groupProps = (g, i) => Boards.members(Boards.groupOf(i));
const ownsGroup = (g, pid, i) => groupProps(g, i).every(k => g.props[k] && g.props[k].owner === pid);

function whyNotBuild(g, pid, i) {
  const sp = g.spaces[i], pr = g.props[i];
  if (!pr || pr.owner !== pid || sp.t !== 'prop') return 'not yours';
  if (!ownsGroup(g, pid, i)) return 'You need the whole color group first.';
  if (groupProps(g, i).some(k => g.props[k].m)) return 'Lift every mortgage in the group first.';
  if (pr.h >= 5) return 'Already has a hotel.';
  const low = Math.min(...groupProps(g, i).map(k => g.props[k].h));
  if (pr.h > low) return 'Build evenly: the others in the group need one first.';
  if (pr.h === 4 ? g.bank.hotels < 1 : g.bank.houses < 1) return pr.h === 4 ? 'The bank is out of hotels.' : 'The bank is out of houses.';
  if (P(g, pid).cash < sp.house) return 'You need ' + money(sp.house) + ' on hand.';
  return null;
}

function build(room, p, i) {
  const g = room.game;
  if (!g || g.phase === 'gameOver' || g.phase === 'rolloff') return;
  const why = whyNotBuild(g, p.id, i);
  if (why) return send(p.ws, { t: 'error', msg: why });
  const sp = g.spaces[i], pr = g.props[i];
  P(g, p.id).cash -= sp.house;
  if (pr.h === 4) { g.bank.hotels--; g.bank.houses += 4; pr.h = 5; }
  else { g.bank.houses--; pr.h++; }
  log(room, pname(room, p.id) + ' builds ' + (pr.h === 5 ? 'a hotel' : 'a house') + ' on ' + sp.name + '.', 'build');
  fx(room, 'build', { pid: p.id, space: i, h: pr.h });
}

// Building across a whole set from one tap: the next house goes on the street in the group with
// the fewest (the cheapest-to-rent one first when tied), so the set always builds evenly.
function nextToBuild(g, pid, i) {
  if (!g.props[i] || g.props[i].owner !== pid || g.spaces[i].t !== 'prop' || !ownsGroup(g, pid, i)) return null;
  const mem = groupProps(g, i).slice().sort((a, b) => (g.props[a].h - g.props[b].h) || (a - b));
  for (const k of mem) if (!whyNotBuild(g, pid, k)) return k;
  return null;
}
function nextToSell(g, pid, i) {
  if (!g.props[i] || g.props[i].owner !== pid || g.spaces[i].t !== 'prop' || !ownsGroup(g, pid, i)) return null;
  const mem = groupProps(g, i).slice().sort((a, b) => (g.props[b].h - g.props[a].h) || (b - a));
  for (const k of mem) if (!whyNotSell(g, pid, k)) return k;
  return null;
}
function buildSet(room, p, i) {
  const g = room.game;
  if (!g || g.phase === 'gameOver' || g.phase === 'rolloff') return;
  const k = nextToBuild(g, p.id, i);
  if (k == null) return send(p.ws, { t: 'error', msg: whyNotBuild(g, p.id, i) || 'Nothing to build.' });
  build(room, p, k);
}
function sellSet(room, p, i) {
  const g = room.game;
  if (!g || g.phase === 'gameOver') return;
  const k = nextToSell(g, p.id, i);
  if (k == null) return send(p.ws, { t: 'error', msg: 'Nothing to sell.' });
  sell(room, p, k);
}

function whyNotSell(g, pid, i) {
  const pr = g.props[i];
  if (!pr || pr.owner !== pid || !pr.h) return 'nothing to sell';
  const high = Math.max(...groupProps(g, i).map(k => (g.props[k] ? g.props[k].h : 0)));
  if (pr.h < high) return 'Sell evenly: the others in the group come down first.';
  return null;
}

function sell(room, p, i) {
  const g = room.game;
  if (!g || g.phase === 'gameOver') return;
  const why = whyNotSell(g, p.id, i);
  if (why) return send(p.ws, { t: 'error', msg: why });
  const sp = g.spaces[i], pr = g.props[i], half = sp.house / 2;
  let got;
  if (pr.h === 5) {
    // A hotel goes back to four houses, or fewer if the bank hasn't got four.
    const back = Math.min(4, g.bank.houses);
    g.bank.hotels++; g.bank.houses -= back; pr.h = back;
    got = half * (5 - back);
  } else { g.bank.houses++; pr.h--; got = half; }
  P(g, p.id).cash += got;
  log(room, pname(room, p.id) + ' sells back a building on ' + sp.name + ' for ' + money(got) + '.', 'sell');
  fx(room, 'sell', { pid: p.id, space: i, h: pr.h });
}

function whyNotMortgage(g, pid, i) {
  const pr = g.props[i];
  if (!pr || pr.owner !== pid || pr.m) return 'not yours';
  if (groupProps(g, i).some(k => g.props[k] && g.props[k].h > 0)) return 'Sell the buildings in the group first.';
  return null;
}

function mortgage(room, p, i) {
  const g = room.game;
  if (!g || g.phase === 'gameOver') return;
  const why = whyNotMortgage(g, p.id, i);
  if (why) return send(p.ws, { t: 'error', msg: why });
  const sp = g.spaces[i];
  g.props[i].m = true;
  P(g, p.id).cash += sp.price / 2;
  log(room, pname(room, p.id) + ' mortgages ' + sp.name + ' for ' + money(sp.price / 2) + '.', 'mortgage');
  fx(room, 'mortgage', { pid: p.id, space: i });
}

const liftCost = sp => Math.round(sp.price / 2 * (1 + MORTGAGE_INTEREST));

function unmortgage(room, p, i) {
  const g = room.game, pr = g && g.props[i];
  if (!g || g.phase === 'gameOver' || !pr || pr.owner !== p.id || !pr.m) return;
  const sp = g.spaces[i], cost = liftCost(sp);
  if (P(g, p.id).cash < cost) return send(p.ws, { t: 'error', msg: 'Lifting the mortgage costs ' + money(cost) + '.' });
  pr.m = false;
  P(g, p.id).cash -= cost;
  log(room, pname(room, p.id) + ' lifts the mortgage on ' + sp.name + ' for ' + money(cost) + '.', 'mortgage');
  fx(room, 'unmortgage', { pid: p.id, space: i });
}

/* -------- trading (any time) */

function cleanSide(g, pid, side) {
  const out = { props: [], cash: 0, chance: false, chest: false };
  if (!side || typeof side !== 'object') return out;
  const me = P(g, pid);
  if (Array.isArray(side.props)) for (const i of side.props.slice(0, 28)) { const k = Number(i); if (Number.isInteger(k) && g.props[k] && g.props[k].owner === pid && !out.props.includes(k)) out.props.push(k); }
  out.cash = Math.max(0, Math.min(Math.round(Number(side.cash) || 0), me.cash));
  out.chance = !!side.chance && me.cards.chance;
  out.chest = !!side.chest && me.cards.chest;
  // "card" means one Get Out of Jail Free card, whichever this player holds.
  if (side.card && !out.chance && !out.chest) { if (me.cards.chance) out.chance = true; else if (me.cards.chest) out.chest = true; }
  return out;
}

// Why a trade can't happen as it stands (null when it can).
function whyNotTrade(room, tr) {
  const g = room.game, a = P(g, tr.from), b = P(g, tr.to);
  if (!a || !b || a.bankrupt || b.bankrupt) return 'Someone in this trade is out of the game.';
  for (const [pid, side] of [[tr.from, tr.give], [tr.to, tr.get]]) {
    const me = P(g, pid);
    for (const i of side.props) {
      if (!g.props[i] || g.props[i].owner !== pid) return g.spaces[i].name + ' changed hands.';
      if (groupProps(g, i).some(k => g.props[k] && g.props[k].owner === pid && g.props[k].h > 0)) return 'Sell the buildings in the ' + Boards.GROUPS[Boards.groupOf(i)].name + ' group before trading ' + g.spaces[i].name + '.';
    }
    if (side.cash > me.cash) return pname(room, pid) + " doesn't have " + money(side.cash) + ' on hand.';
    if (side.chance && !me.cards.chance) return 'That Chance card is gone.';
    if (side.chest && !me.cards.chest) return 'That Community Chest card is gone.';
  }
  if (!tr.give.props.length && !tr.give.cash && !tr.give.chance && !tr.give.chest && !tr.get.props.length && !tr.get.cash && !tr.get.chance && !tr.get.chest) return 'An empty trade.';
  // Whoever receives a mortgaged property pays the 10% interest on it right away.
  const interest = (pid, props) => props.filter(i => g.props[i].m).reduce((s, i) => s + Math.round(g.spaces[i].price / 2 * MORTGAGE_INTEREST), 0);
  const aAfter = a.cash - tr.give.cash + tr.get.cash - interest(tr.from, tr.get.props);
  const bAfter = b.cash - tr.get.cash + tr.give.cash - interest(tr.to, tr.give.props);
  if (aAfter < 0) return pname(room, tr.from) + " can't cover the interest on the mortgaged property.";
  if (bAfter < 0) return pname(room, tr.to) + " can't cover the interest on the mortgaged property.";
  return null;
}

function offerTrade(room, p, m) {
  const g = room.game;
  if (!g || g.phase === 'gameOver' || g.phase === 'rolloff') return;
  const to = String(m.to || '');
  if (to === p.id || !g.players[to]) return;
  const tr = { id: ++g.tradeSeq, from: p.id, to, give: cleanSide(g, p.id, m.give), get: cleanSide(g, to, m.get), at: Date.now(), note: clean(m.note, 60) };
  const why = whyNotTrade(room, tr);
  if (why) return send(p.ws, { t: 'error', msg: why });
  g.trades = g.trades.filter(t => !(t.from === p.id && t.to === to));
  if (g.trades.length >= 10) g.trades.shift();
  g.trades.push(tr);
  log(room, pname(room, p.id) + ' offers ' + pname(room, to) + ' a trade.', 'trade');
  fx(room, 'tradeOffer', { id: tr.id, from: p.id, to });
}

function answerTrade(room, p, id, accept) {
  const g = room.game;
  if (!g) return;
  const tr = g.trades.find(t => t.id === Number(id));
  if (!tr || tr.to !== p.id) return;
  g.trades = g.trades.filter(t => t !== tr);
  if (!accept) { log(room, pname(room, p.id) + ' turns down ' + pname(room, tr.from) + "'s trade.", 'trade'); fx(room, 'tradeNo', { from: tr.from, to: tr.to }); return; }
  const why = whyNotTrade(room, tr);
  if (why) { send(p.ws, { t: 'error', msg: why }); send(room.players.get(tr.from).ws, { t: 'error', msg: 'Your trade with ' + p.name + " fell through: " + why }); return; }
  const a = P(g, tr.from), b = P(g, tr.to);
  const swap = (fromId, toId, side) => {
    const me = P(g, fromId), them = P(g, toId);
    for (const i of side.props) { g.props[i].owner = toId; if (g.props[i].m) them.cash -= Math.round(g.spaces[i].price / 2 * MORTGAGE_INTEREST); }
    me.cash -= side.cash; them.cash += side.cash;
    if (side.chance) { me.cards.chance = false; them.cards.chance = true; }
    if (side.chest) { me.cards.chest = false; them.cards.chest = true; }
  };
  const beforeA = fullSets(g, tr.from), beforeB = fullSets(g, tr.to);
  swap(tr.from, tr.to, tr.give);
  swap(tr.to, tr.from, tr.get);
  void a; void b;
  const part = (side, g2) => {
    const bits = side.props.map(i => g2.spaces[i].name);
    if (side.cash) bits.push(money(side.cash));
    if (side.chance || side.chest) bits.push('a Get Out of Jail Free card');
    return bits.length ? bits.join(', ') : 'nothing';
  };
  log(room, pname(room, tr.from) + ' trades ' + part(tr.give, g) + ' to ' + pname(room, tr.to) + ' for ' + part(tr.get, g) + '.', 'trade');
  fx(room, 'trade', { from: tr.from, to: tr.to, give: tr.give, get: tr.get });
  noteSets(room, tr.from, beforeA); noteSets(room, tr.to, beforeB);
  // A trade can be the thing that pays a debt: check again.
  if (g.phase === 'debt') settleDebtIfPaid(room);
}

function cancelTrade(room, p, id) {
  const g = room.game;
  if (!g) return;
  g.trades = g.trades.filter(t => !(t.id === Number(id) && t.from === p.id));
}

/* -------- debts and bankruptcy */

function settleDebtIfPaid(room) {
  const g = room.game, d = g.debts[0];
  if (!d) return settle(room);
  if (P(g, d.pid).cash >= d.amount) payDebt(room, room.players.get(d.pid));
}

function payDebt(room, p) {
  const g = room.game, d = g && g.debts[0];
  if (!d || g.phase !== 'debt' || d.pid !== p.id) return;
  const me = P(g, p.id);
  if (me.cash < d.amount) return send(p.ws, { t: 'error', msg: 'You still need ' + money(d.amount - me.cash) + ' more.' });
  pay(room, p.id, d.to, d.amount);
  g.debts.shift();
  log(room, pname(room, p.id) + ' pays ' + money(d.amount) + (d.to && d.to !== 'bank' && d.to !== 'each' ? ' to ' + pname(room, d.to) : '') + '.', 'pay');
  fx(room, 'paid', { pid: p.id, amount: d.amount, to: d.to });
  stopClock(room);
  settle(room);
}

// Everything that could be turned into cash right now (houses at half, mortgages taken).
function liquid(g, pid) {
  let v = P(g, pid).cash;
  for (const i of Object.keys(g.props)) {
    const pr = g.props[i], sp = g.spaces[i];
    if (pr.owner !== pid) continue;
    if (pr.h) v += pr.h * (sp.house || 0) / 2;
    if (!pr.m) v += sp.price / 2;
  }
  return v;
}

// Cash plus property at list price (mortgaged ones at half) plus buildings at cost.
function netWorth(g, pid) {
  const me = P(g, pid);
  if (me.bankrupt) return 0;
  let v = me.cash;
  for (const i of Object.keys(g.props)) {
    const pr = g.props[i], sp = g.spaces[i];
    if (pr.owner !== pid) continue;
    v += pr.m ? sp.price / 2 : sp.price;
    v += (pr.h || 0) * (sp.house || 0);
  }
  return v;
}

function declareBankruptcy(room, p) {
  const g = room.game, d = g && g.debts[0];
  if (!d || g.phase !== 'debt' || d.pid !== p.id) return;
  if (liquid(g, p.id) >= d.amount) return send(p.ws, { t: 'error', msg: 'You can still raise ' + money(d.amount) + ' by selling buildings or mortgaging. Bankruptcy is for when you really can\'t.' });
  goBankrupt(room, p.id, d);
}

// opts.left: they walked away rather than going broke. opts.quiet: it isn't their move, so
// whatever is happening on the board carries on undisturbed.
function goBankrupt(room, pid, d, opts) {
  opts = opts || {};
  const g = room.game, me = P(g, pid), name = pname(room, pid);
  const creditor = d.to && d.to !== 'bank' && d.to !== 'each' ? d.to : null;
  // Buildings go back to the bank for half, and that cash goes where the rest does.
  let fromBuildings = 0;
  for (const i of Object.keys(g.props)) {
    const pr = g.props[i], sp = g.spaces[i];
    if (pr.owner !== pid || !pr.h) continue;
    fromBuildings += pr.h * sp.house / 2;
    if (pr.h === 5) g.bank.hotels++; else g.bank.houses += pr.h;
    pr.h = 0;
  }
  const cash = me.cash + fromBuildings;
  me.cash = 0;
  const mine = Object.keys(g.props).map(Number).filter(i => g.props[i].owner === pid);
  if (creditor) {
    const c = P(g, creditor), beforeC = fullSets(g, creditor);
    c.cash += cash;
    for (const i of mine) { g.props[i].owner = creditor; if (g.props[i].m) { const due = Math.round(g.spaces[i].price / 2 * MORTGAGE_INTEREST); if (c.cash >= due) c.cash -= due; } }
    if (me.cards.chance) { c.cards.chance = true; me.cards.chance = false; }
    if (me.cards.chest) { c.cards.chest = true; me.cards.chest = false; }
    log(room, name + (opts.left ? ' leaves the game owing ' + pname(room, creditor) + '. Everything goes to them' : ' goes bankrupt. Everything goes to ' + pname(room, creditor)) + ': ' + money(cash) + (mine.length ? ' and ' + mine.length + ' properties' : '') + '.', 'bankrupt');
    noteSets(room, creditor, beforeC);
  } else {
    for (const i of mine) { delete g.props[i]; g.auctionQueue.push(i); }
    const deck = Cards.deckById(g.deck).cards;
    for (const which of ['chance', 'chest']) if (me.cards[which]) { me.cards[which] = false; const idx = deck[which].findIndex(c => c.k === 'jailfree'); if (idx >= 0) g.decks[which].push(idx); }
    log(room, name + (opts.left ? ' leaves the game.' : ' goes bankrupt to the bank.') + (mine.length ? ' Their ' + mine.length + ' properties go up for auction.' : ''), 'bankrupt');
  }
  me.bankrupt = true; me.out = ++g.outCount; me.jail = false; if (opts.left) me.left = true;
  if (g.card && g.card.pid === pid) g.card = null;
  if (g.offer && g.offer.pid === pid) g.offer = null;
  g.debts = g.debts.filter(x => x.pid !== pid);
  g.trades = g.trades.filter(t => t.from !== pid && t.to !== pid);
  if (g.auction) { g.auction.passed = g.auction.passed.filter(id => id !== pid); if (g.auction.bidder === pid) { g.auction.bidder = null; g.auction.bid = 0; } }
  fx(room, opts.left ? 'leftGame' : 'bankrupt', { pid, to: creditor, props: mine.length });
  if (alive(room, g).length <= 1) { stopClock(room); return endGame(room, 'last'); }
  if (opts.quiet) {
    // Their properties wait for the end of the current move to go up for auction (see nextTurn).
    if (g.auction && g.phase === 'auction') checkAuction(room);
    return;
  }
  stopClock(room);
  settle(room);
}

// Sells and mortgages, most valuable first, until the debt is covered. Used when a phone has
// dropped off, or the turn clock runs out. Bankrupt if it still isn't enough.
function autoLiquidate(room, pid) {
  const g = room.game, d = g.debts[0], me = P(g, pid), p = room.players.get(pid);
  if (!d || d.pid !== pid) return;
  let guard = 0;
  while (me.cash < d.amount && guard++ < 100) {
    const mine = Object.keys(g.props).map(Number).filter(i => g.props[i].owner === pid);
    const sellable = mine.filter(i => !whyNotSell(g, pid, i)).sort((a, b) => g.spaces[b].house - g.spaces[a].house);
    if (sellable.length) { sell(room, p, sellable[0]); continue; }
    const mortgageable = mine.filter(i => !whyNotMortgage(g, pid, i)).sort((a, b) => g.spaces[b].price - g.spaces[a].price);
    if (mortgageable.length) { mortgage(room, p, mortgageable[0]); continue; }
    break;
  }
  if (me.cash >= d.amount) payDebt(room, p);
  else goBankrupt(room, pid, d);
}

/* -------- the end */

function ranking(room) {
  const g = room.game, ids = seats(room);
  const live = ids.filter(id => !P(g, id).bankrupt).map(id => ({ id, net: netWorth(g, id), cash: P(g, id).cash }))
    .sort((a, b) => b.net - a.net || b.cash - a.cash || pname(room, a.id).localeCompare(pname(room, b.id)));
  const gone = ids.filter(id => P(g, id).bankrupt).sort((a, b) => P(g, b).out - P(g, a).out).map(id => ({ id, net: 0, cash: 0, out: P(g, id).out, left: !!P(g, id).left }));
  return live.concat(gone).map((r, k) => Object.assign({ place: k + 1, name: pname(room, r.id) }, r));
}

function endGame(room, why) {
  const g = room.game;
  stopClock(room);
  if (room.endTimer) { clearTimeout(room.endTimer); room.endTimer = null; }
  g.phase = 'gameOver'; g.why = why; g.auction = null; g.offer = null; g.card = null; g.landing = null;
  g.ranking = ranking(room);
  g.winner = g.ranking.length ? g.ranking[0].id : null;
  g.awards = awards(room);
  log(room, why === 'time' ? "Time's up! " + pname(room, g.winner) + ' wins on net worth.' : pname(room, g.winner) + ' is the last one standing.', 'win');
  fx(room, 'win', { pid: g.winner, why });
}

function awards(room) {
  const g = room.game, ids = seats(room);
  const rows = ids.map(id => ({ id, name: pname(room, id), s: P(g, id).stats, p: P(g, id) }));
  const out = [];
  const landlord = rows.filter(r => r.s.rent > 0).sort((a, b) => b.s.rent - a.s.rent)[0];
  if (landlord) out.push({ key: 'landlord', title: 'SLUMLORD', id: landlord.id, name: landlord.name, note: money(landlord.s.rent) + ' collected in rent' });
  const tenant = rows.filter(r => r.s.rentPaid > 0).sort((a, b) => b.s.rentPaid - a.s.rentPaid)[0];
  if (tenant) out.push({ key: 'tenant', title: 'BEST TENANT', id: tenant.id, name: tenant.name, note: money(tenant.s.rentPaid) + ' paid in rent' });
  const jailbird = rows.filter(r => r.s.jail > 0).sort((a, b) => b.s.jail - a.s.jail)[0];
  if (jailbird) out.push({ key: 'jail', title: 'JAILBIRD', id: jailbird.id, name: jailbird.name, note: jailbird.s.jail + (jailbird.s.jail === 1 ? ' trip' : ' trips') + ' to jail' });
  const shopper = rows.filter(r => r.s.bought > 0).sort((a, b) => b.s.bought - a.s.bought)[0];
  if (shopper) out.push({ key: 'shopper', title: 'BIG SPENDER', id: shopper.id, name: shopper.name, note: shopper.s.bought + (shopper.s.bought === 1 ? ' property' : ' properties') + ' bought' });
  return out.slice(0, 4);
}

/* -------- playing for a phone that isn't there */

// Who the game is waiting on right now.
function actor(g) {
  if (!g) return null;
  if (g.phase === 'turn') return g.cur;
  if (g.phase === 'buy' && g.offer) return g.offer.pid;
  if (g.phase === 'debt' && g.debts[0]) return g.debts[0].pid;
  return null;
}

function autoAct(room, force) {
  const g = room.game, id = actor(g);
  if (!id) return false;
  const p = room.players.get(id);
  if (!p) return false;
  // Someone who hasn't come back since the game was picked up gets much longer before the game plays for them.
  const idle = (p.waitingFor ? IDLE_MS * 7 : IDLE_MS) / SPEED;
  if (!force && (p.connected || !p.goneAt || Date.now() - p.goneAt < idle)) return false;
  fx(room, 'auto', { pid: id });
  if (g.phase === 'turn') { log(room, pname(room, id) + ' is away: the game rolls for them.', 'auto'); doRoll(room, p); }
  else if (g.phase === 'buy') { log(room, pname(room, id) + ' is away: the property goes to auction.', 'auto'); decline(room, p); }
  else if (g.phase === 'debt') { log(room, pname(room, id) + ' is away: the game raises the money for them.', 'auto'); autoLiquidate(room, id); }
  return true;
}

/* -------- completing a color group is worth a fanfare */

const fullSets = (g, pid) => Object.keys(Boards.GROUPS).filter(gr => gr !== 'rail' && gr !== 'util' && Boards.members(gr).every(k => g.props[k] && g.props[k].owner === pid));

function noteSets(room, pid, before) {
  const g = room.game;
  for (const gr of fullSets(g, pid)) if (!before.includes(gr)) {
    log(room, pname(room, pid) + ' owns the whole ' + Boards.GROUPS[gr].name.toLowerCase() + ' set!', 'monopoly');
    fx(room, 'monopoly', { pid, group: gr });
  }
}

/* -------- private messages between two phones */

const chatKey = (a, b) => [a, b].sort().join('|');

function chat(room, p, m) {
  const to = String(m.to || ''), other = room.players.get(to);
  if (!other || other === p || other.bot) return;
  const text = clean(m.text, 240);
  if (!text) return;
  const k = chatKey(p.id, to);
  const list = room.chats[k] || (room.chats[k] = []);
  list.push({ from: p.id, text, at: Date.now() });
  if (list.length > 60) list.shift();
}

function chatsFor(room, pid) {
  const out = {};
  for (const k of Object.keys(room.chats)) {
    const [a, b] = k.split('|');
    if (a === pid || b === pid) out[a === pid ? b : a] = room.chats[k];
  }
  return out;
}

/* -------- bots: players the TV adds, who play a plain, sensible game */

function addBot(room) {
  if (room.game || seats(room).length >= MAX_PLAYERS) return;
  const used = new Set([...room.players.values()].map(p => p.name));
  const name = BOT_NAMES.find(n => !used.has(n)) || ('BOT ' + crypto.randomInt(100, 999));
  const p = { id: rid(6), token: rid(), name, piece: freePiece(room, BOT_PIECES), color: freeColor(room), bot: true, connected: true, ws: null, hold: 0, goneAt: 0 };
  room.players.set(p.id, p);
  room.order.push(p.id);
  fx(room, 'joined', { name: p.name, pid: p.id, bot: true });
}

const isBot = (room, id) => { const p = room.players.get(id); return !!(p && p.bot); };

// Something a bot should get round to?
function botHasWork(room) {
  const g = room.game;
  if (!g || g.phase === 'gameOver') return false;
  const a = actor(g);
  if (a && isBot(room, a)) return true;
  if (g.phase === 'auction' && g.auction && alive(room, g).some(id => isBot(room, id) && !g.auction.passed.includes(id) && g.auction.bidder !== id)) return true;
  if (g.trades.some(t => isBot(room, t.to))) return true;
  return false;
}

function scheduleBots(room) {
  if (room.botTimer || !botHasWork(room)) return;
  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    if (rooms.get(room.code) !== room) return;
    let changed = false;
    try { changed = botTick(room); } catch (e) { console.error('bot error', e); }
    if (changed) pushAll(room); else scheduleBots(room);
  }, (BOT_MS + crypto.randomInt(900)) / SPEED);
}

// Steady, a little greedy: 8 bots play 8 slightly different games thanks to a per-bot "nerve".
const nerve = (id, salt) => (crypto.createHash('sha1').update(id + '|' + (salt || '')).digest()[0] / 255);

function botTick(room) {
  const g = room.game;
  if (!g || g.phase === 'gameOver') return false;
  const a = actor(g);
  if (a && isBot(room, a)) {
    const p = room.players.get(a), me = P(g, a);
    if (g.phase === 'turn') {
      // Build first, one house at a time, keeping a cushion in the bank.
      const cushion = 300 + Math.round(nerve(a, 'cushion') * 400);
      const mine = Object.keys(g.props).map(Number).filter(i => g.props[i].owner === a && g.spaces[i].t === 'prop');
      const target = mine.filter(i => !whyNotBuild(g, a, i) && me.cash - g.spaces[i].house >= cushion).sort((x, y) => g.spaces[y].rent[1] - g.spaces[x].rent[1])[0];
      if (target != null) { build(room, p, target); return true; }
      const lift = Object.keys(g.props).map(Number).find(i => g.props[i].owner === a && g.props[i].m && me.cash - liftCost(g.spaces[i]) >= cushion + 200);
      if (lift != null) { unmortgage(room, p, lift); return true; }
      if (botProposeTrade(room, a)) return true;
      if (me.jail) {
        if (me.cards.chance || me.cards.chest) useJailCard(room, p);
        else if (me.cash >= JAIL_FINE + 200 && me.jailTurns > 0) payJail(room, p);
        else jailRoll(room, p);
        return true;
      }
      doRoll(room, p);
      return true;
    }
    if (g.phase === 'buy' && g.offer) {
      const sp = g.spaces[g.offer.space];
      const completes = sp.t === 'prop' && Boards.members(sp.g).every(k => k === sp.i || (g.props[k] && g.props[k].owner === a));
      const keep = completes ? 0 : 120 + Math.round(nerve(a, 'keep') * 300);
      if (me.cash >= sp.price + keep) buy(room, p); else decline(room, p);
      return true;
    }
    if (g.phase === 'debt') { autoLiquidate(room, a); return true; }
  }
  if (g.phase === 'auction' && g.auction) {
    const au = g.auction, sp = g.spaces[au.space];
    for (const id of alive(room, g)) {
      if (!isBot(room, id) || au.passed.includes(id) || au.bidder === id) continue;
      const p = room.players.get(id), me = P(g, id);
      const completes = sp.t === 'prop' && Boards.members(sp.g).every(k => k === sp.i || (g.props[k] && g.props[k].owner === id));
      const ceiling = Math.min(me.cash - 80, Math.round(sp.price * (completes ? 1.3 : 0.55 + nerve(id, 'bid' + sp.i) * 0.6)));
      const step = au.bid < 100 ? 10 : au.bid < 300 ? 25 : 50;
      const next = Math.max(10, au.bid + step);
      if (next <= ceiling) bid(room, p, next); else passAuction(room, p);
      return true;
    }
  }
  const tr = g.trades.find(t => isBot(room, t.to));
  if (tr) {
    const p = room.players.get(tr.to);
    answerTrade(room, p, tr.id, botLikesTrade(room, tr));
    return true;
  }
  return false;
}

// A bot one property short of a set goes shopping for it now and then: cash, plus a property it
// has no use for if the cash alone looks thin.
function botProposeTrade(room, a) {
  const g = room.game, me = P(g, a);
  if (g.trades.some(t => t.from === a) || g.tradeSeq + g.turnCount > 0 && crypto.randomInt(4) !== 0) return false;
  const mineProps = Object.keys(g.props).map(Number).filter(i => g.props[i].owner === a);
  const want = [];
  for (const gr of Object.keys(Boards.GROUPS)) {
    if (gr === 'rail' || gr === 'util') continue;
    const mem = Boards.members(gr), have = mem.filter(k => g.props[k] && g.props[k].owner === a);
    if (have.length !== mem.length - 1) continue;
    const miss = mem.find(k => !have.includes(k));
    const pr = g.props[miss];
    if (!pr || pr.owner === a || P(g, pr.owner).bankrupt || pr.h) continue;
    want.push({ i: miss, owner: pr.owner });
  }
  if (!want.length) return false;
  const pick = want[crypto.randomInt(want.length)], sp = g.spaces[pick.i];
  let cash = Math.min(me.cash - 200, Math.round(sp.price * (1.6 + nerve(a, 'offer') * 0.8)));
  const spare = mineProps.filter(i => { const s2 = g.spaces[i]; if (!s2.g || s2.g === 'rail' || s2.g === 'util') return false; const mem = Boards.members(s2.g); return mem.filter(k => g.props[k] && g.props[k].owner === a).length === 1 && !g.props[i].h; });
  const props = [];
  if (cash < sp.price * 1.5 && spare.length) { props.push(spare.sort((x, y) => g.spaces[y].price - g.spaces[x].price)[0]); cash = Math.max(0, Math.min(cash, Math.round(sp.price * 0.8))); }
  if (cash < sp.price * 0.6 && !props.length) return false;
  const p = room.players.get(a);
  offerTrade(room, p, { to: pick.owner, give: { props, cash }, get: { props: [pick.i], cash: 0 }, note: 'Looking to finish the ' + Boards.GROUPS[sp.g].name.toLowerCase() + ' set' });
  return g.trades.some(t => t.from === a);
}

// What a side of a trade is worth to the bot, and whether the deal is good enough.
function botLikesTrade(room, tr) {
  const g = room.game, me = tr.to;
  const worth = (side, forMe) => {
    let v = side.cash + (side.chance ? 40 : 0) + (side.chest ? 40 : 0);
    for (const i of side.props) {
      const sp = g.spaces[i], pr = g.props[i];
      let w = pr.m ? sp.price * 0.4 : sp.price;
      if (sp.t === 'prop') {
        const others = Boards.members(sp.g).filter(k => k !== i);
        const ownAfter = others.every(k => g.props[k] && g.props[k].owner === (forMe ? me : tr.from));
        if (ownAfter) w *= 1.8;                       // it completes a set for whoever gets it
        if (!forMe && others.every(k => g.props[k] && g.props[k].owner === me)) w *= 2.2;   // giving up a set of mine
      }
      v += w;
    }
    return v;
  };
  const get = worth(tr.give, true), give = worth(tr.get, false);
  return get >= give * (1.05 + nerve(me, 'trade') * 0.2) && P(g, me).cash - tr.get.cash >= 50;
}

/* ----------------------------------------------------- lobby and TV actions */

function adminAction(room, m) {
  const g = room.game;
  switch (m.a) {
    case 'start': if (!g) startGame(room); return;
    case 'settings':
      if (g) return;
      if (typeof m.theme === 'string' && Boards.themeById(m.theme, room.custom.boards).id === m.theme) room.settings.theme = m.theme;
      if (typeof m.deck === 'string' && Cards.DECKS.some(d => d.id === m.deck)) room.settings.deck = m.deck;
      if (m.mode === 'timer' || m.mode === 'last') room.settings.mode = m.mode;
      if (Number.isFinite(Number(m.minutes))) room.settings.minutes = Math.max(5, Math.min(600, Math.round(Number(m.minutes))));
      if (TURN_CHOICES.includes(m.turnSecs)) room.settings.turnSecs = m.turnSecs;
      if (AUCTION_CHOICES.includes(m.auctionSecs)) room.settings.auctionSecs = m.auctionSecs;
      return;
    case 'custom': if (!g) { room.custom = cleanCustom(m.custom); if (!room.custom.boards.some(b => b.id === room.settings.theme) && room.settings.theme.startsWith('custom:')) room.settings.theme = 'classic'; } return;
    case 'kick': {
      const x = room.players.get(m.id);
      if (x) dropPlayer(room, x, true);
      return;
    }
    case 'addBot': if (!g) addBot(room); return;
    case 'removeBot': {
      if (g) return;
      const bots = seats(room).map(id => room.players.get(id)).filter(x => x.bot);
      const x = m.id ? room.players.get(m.id) : bots[bots.length - 1];
      if (x && x.bot) dropPlayer(room, x, true);
      return;
    }
    case 'lobby':
      if (g) { stopClock(room); if (room.endTimer) { clearTimeout(room.endTimer); room.endTimer = null; } room.game = null; fx(room, 'lobby'); }
      return;
    case 'endGame':
      if (g && g.phase !== 'gameOver') endGame(room, 'early');
      return;
    case 'addTime': {
      const mins = Number(m.minutes);
      if (!g || g.phase === 'gameOver' || !g.endsAt || !ADD_TIME_CHOICES.includes(mins)) return;
      g.endsAt += mins * 60000 / SPEED;
      log(room, 'The TV adds ' + mins + ' minutes to the clock.', 'time');
      fx(room, 'time', { minutes: mins });
      armEndTimer(room);
      return;
    }
  }
}

/* ----------------------------------------------------------------- state */

function publicState(room) {
  const g = room.game;
  const pl = id => { const p = room.players.get(id); return p ? { id: p.id, name: p.name, on: p.connected, piece: p.piece, color: p.color, photo: p.photoV ? '/photo/' + room.code + '/' + p.id + '?v=' + p.photoV : null, bot: !!p.bot } : null; };
  const theme = themeOf(room);
  const s = {
    code: room.code,
    phase: g ? g.phase : 'lobby',
    players: seats(room).map(pl).filter(Boolean),
    captain: captainId(room),
    settings: room.settings,
    themes: Boards.THEMES.concat(room.custom.boards).map(t => ({ id: t.id, name: t.name, blurb: t.blurb, custom: !!t.custom })),
    decks: Cards.DECKS.map(d => ({ id: d.id, name: d.name, blurb: d.blurb, adult: !!d.adult })),
    names: spacesOf(room).map(sp => sp.name),
    rails: theme.rails,
    pieces: PIECES, colors: COLORS, minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS, minuteChoices: MINUTE_CHOICES, turnChoices: TURN_CHOICES, auctionChoices: AUCTION_CHOICES, addTimeChoices: ADD_TIME_CHOICES,
    fx: room.fx,
    game: null
  };
  if (g) {
    const players = {};
    for (const id of Object.keys(g.players)) {
      const p = g.players[id];
      players[id] = { cash: p.cash, pos: p.pos, jail: p.jail, jailTurns: p.jailTurns, cards: (p.cards.chance ? 1 : 0) + (p.cards.chest ? 1 : 0), bankrupt: p.bankrupt, left: !!p.left, out: p.out, net: netWorth(g, id) };
    }
    s.game = {
      theme: g.theme, deck: g.deck, mode: g.mode, order: g.order, cur: g.cur, roll: g.roll, rolloff: g.rolloff, turnCount: g.turnCount,
      players, props: g.props, bank: g.bank,
      card: g.card ? { which: g.card.which, pid: g.card.pid, text: g.card.text } : null,
      offer: g.offer, auction: g.auction,
      debts: g.debts.map(d => ({ pid: d.pid, to: d.to, amount: d.amount, reason: d.reason })),
      trades: g.trades.map(t => ({ id: t.id, from: t.from, to: t.to, give: t.give, get: t.get, note: t.note })),
      clock: g.clock && g.clock.show ? { what: g.clock.what, left: Math.max(0, g.clock.at - Date.now()), len: g.clock.len } : null,
      timeLeft: g.endsAt ? Math.max(0, g.endsAt - Date.now()) : null,
      log: g.log.slice(-40), ranking: g.ranking, winner: g.winner, why: g.why, awards: g.awards || null, actor: actor(g)
    };
  }
  return s;
}

function stateFor(room, pub, p) {
  const s = Object.assign({}, pub);
  const g = room.game;
  const playing = room.order.includes(p.id);
  s.me = { id: p.id, name: p.name, piece: p.piece, color: p.color, photo: p.photoV ? '/photo/' + room.code + '/' + p.id + '?v=' + p.photoV : null, isCaptain: pub.captain === p.id, playing };
  s.me.chats = chatsFor(room, p.id);
  if (g && playing && g.players[p.id]) {
    const me = g.players[p.id];
    s.me.cash = me.cash; s.me.pos = me.pos; s.me.jail = me.jail; s.me.jailTurns = me.jailTurns; s.me.cards = me.cards; s.me.bankrupt = me.bankrupt;
    s.me.myTurn = g.cur === p.id && g.phase === 'turn';
    s.me.canRoll = s.me.myTurn;
    s.me.canPayJail = s.me.myTurn && me.jail && me.cash >= JAIL_FINE;
    s.me.canUseCard = s.me.myTurn && me.jail && (me.cards.chance || me.cards.chest);
    s.me.offer = g.phase === 'buy' && g.offer && g.offer.pid === p.id ? g.offer.space : null;
    s.me.debt = g.phase === 'debt' && g.debts[0] && g.debts[0].pid === p.id ? Object.assign({}, g.debts[0], { liquid: liquid(g, p.id) }) : null;
    s.me.inAuction = g.phase === 'auction' && !me.bankrupt && !!g.auction && !g.auction.passed.includes(p.id);
    s.me.props = {};
    for (const i of Object.keys(g.props)) {
      if (g.props[i].owner !== p.id) continue;
      const nb = g.spaces[i].t === 'prop' ? nextToBuild(g, p.id, Number(i)) : null, ns = g.spaces[i].t === 'prop' ? nextToSell(g, p.id, Number(i)) : null;
      s.me.props[i] = {
        build: g.spaces[i].t === 'prop' ? whyNotBuild(g, p.id, Number(i)) : 'n/a',
        buildNext: nb, buildNextWhy: g.spaces[i].t === 'prop' && nb == null ? whyNotBuild(g, p.id, Number(i)) : null,
        sellNext: ns,
        sell: whyNotSell(g, p.id, Number(i)),
        mortgage: whyNotMortgage(g, p.id, Number(i)),
        lift: g.props[i].m ? (me.cash >= liftCost(g.spaces[i]) ? null : 'You need ' + money(liftCost(g.spaces[i])) + '.') : 'n/a',
        liftCost: liftCost(g.spaces[i])
      };
    }
    s.me.jailFine = JAIL_FINE;
    if (g.phase === 'gameOver') {
      s.me.place = (g.ranking.find(r => r.id === p.id) || {}).place || null;
      s.me.awards = (g.awards || []).filter(a => a.id === p.id).map(a => a.key);
      s.me.stats = me.stats;
    }
  }
  return s;
}

function pushAll(room) {
  room.touched = Date.now();
  const pub = publicState(room);
  if (room.displays.size) {
    const d = JSON.stringify({ t: 'state', s: Object.assign({}, pub, { display: true }) });
    for (const ws of room.displays) if (ws.readyState === 1) ws.send(d);
  }
  for (const p of room.players.values()) {
    if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify({ t: 'state', s: stateFor(room, pub, p) }));
  }
  queueBackup(room);
  scheduleBots(room);
}

/* -------------------------------------------------------------- messages */

function dropPlayer(room, p, kicked) {
  const g = room.game;
  const i = room.order.indexOf(p.id);
  if (g && g.players[p.id] && !g.players[p.id].bankrupt && g.phase !== 'gameOver') {
    // Leaving a running game is the same as going bankrupt: to whoever they owe right now, else
    // to the bank. If it's their move the game moves on; if not, the move in progress carries on.
    const owed = g.debts.find(x => x.pid === p.id);
    const involved = g.cur === p.id || actor(g) === p.id || (g.landing && g.landing.pid === p.id) || (g.card && g.card.pid === p.id);
    goBankrupt(room, p.id, owed || { pid: p.id, to: 'bank', amount: 0, reason: 'left' }, { left: true, quiet: !involved });
  } else if (!g && i >= 0) room.order.splice(i, 1);
  if (!g || !g.players[p.id]) room.players.delete(p.id);
  else if (!p.bot) p.connected = false;
  if (p.ws) {
    send(p.ws, { t: 'left', kicked: !!kicked });
    p.ws.room = null; p.ws.pid = null; p.ws = null;
  }
  if (!seats(room).length && g) { stopClock(room); room.game = null; fx(room, 'lobby'); }
}

function attach(ws, room, p) {
  if (p.ws && p.ws !== ws) {
    send(p.ws, { t: 'left', replaced: true });
    p.ws.room = null; p.ws.pid = null;
    try { p.ws.close(); } catch (e) { /* ignore */ }
  }
  p.ws = ws; p.connected = true; p.hold = 0; p.goneAt = 0; p.waitingFor = false;
  ws.room = room; ws.pid = p.id;
}

const justStarted = () => Date.now() - BOOT < RESTORE_WINDOW_MS;

function showOn(ws, room, admin) {
  if (ws.display && ws.room && ws.room !== room) ws.room.displays.delete(ws);
  ws.room = room; ws.display = true; ws.admin = admin;
  room.displays.add(ws);
}

// A photo piece arrives as a data URL. Keep it small and only allow plain image types.
function cleanPhoto(s) {
  s = String(s == null ? '' : s);
  if (!s || s.length > PHOTO_MAX) return null;
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(s);
  if (!m) return null;
  const bytes = Buffer.from(m[2], 'base64');
  const ok = m[1] === 'jpeg' ? bytes[0] === 0xff && bytes[1] === 0xd8 : m[1] === 'png' ? bytes[0] === 0x89 && bytes[1] === 0x50 : bytes.slice(8, 12).toString() === 'WEBP';
  return ok ? s : null;
}
const photoV = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);
function setPhoto(p, s) { p.photo = s || null; p.photoV = s ? photoV(s) : null; }

const pieceTaken = (room, piece, except) => [...room.players.values()].some(x => x !== except && x.piece === piece);
const colorTaken = (room, n, except) => [...room.players.values()].some(x => x !== except && x.color === n);
function freeColor(room) {
  for (let n = 0; n < COLORS; n++) if (!colorTaken(room, n, null)) return n;
  return room.players.size % COLORS;
}
function freePiece(room, list) {
  for (const pc of list || PIECES) if (!pieceTaken(room, pc, null)) return pc;
  return (list || PIECES)[0];
}

function onMessage(ws, m) {
  if (!m || typeof m.t !== 'string') return;
  if (m.t === 'ping') return;

  if (m.t === 'create') {
    const room = newRoom();
    room.custom = cleanCustom(m.custom);
    showOn(ws, room, true);
    send(ws, { t: 'created', code: room.code, token: room.adminToken });
    return pushAll(room);
  }

  if (m.t === 'load') {
    if (typeof m.blob !== 'string' || m.blob.length > BACKUP_MAX) return send(ws, { t: 'error', msg: "That saved game can't be read." });
    const room = loadRoom(m.blob);
    if (!room) return send(ws, { t: 'error', msg: "That saved game can't be opened here. It was saved by a different server." });
    showOn(ws, room, true);
    send(ws, { t: 'created', code: room.code, token: room.adminToken, loaded: true });
    return pushAll(room);
  }

  if (m.t === 'watch' || m.t === 'restore') {
    const code = clean(m.code, 4).toUpperCase();
    let room = rooms.get(code), restored = false;
    if (!room && m.t === 'restore' && typeof m.blob === 'string' && m.blob.length <= BACKUP_MAX) {
      room = restoreRoom(m.blob, code, m.token, m.idle);
      restored = !!room;
    }
    if (!room) return send(ws, { t: 'error', code: 'noroom', msg: 'That game is no longer running.', wait: m.t === 'watch' && justStarted() });
    showOn(ws, room, m.token === room.adminToken);
    send(ws, { t: 'watching', code: room.code, admin: ws.admin, restored });
    return pushAll(room);
  }

  if (m.t === 'join') {
    const room = rooms.get(clean(m.code, 4).toUpperCase());
    if (!room) return send(ws, { t: 'error', code: 'noroom', msg: "Can't find that room. Check the 4-letter code on the TV.", wait: justStarted() });
    const name = clean(m.name, 12).toUpperCase();
    if (!name) return send(ws, { t: 'error', msg: 'Enter your name.' });
    let p = [...room.players.values()].find(x => x.name === name);
    if (p) {
      if (p.connected) return send(ws, { t: 'error', msg: 'Someone is already playing as ' + name + '. Pick another name.' });
      if (p.hold && Date.now() < p.hold) return send(ws, { t: 'error', msg: name + ' is still reconnecting. Try again in a few seconds, or pick another name.' });
      p.token = rid();
    } else {
      if (room.game) return send(ws, { t: 'error', msg: 'That game has already started. If you were in it, use the exact name you joined with.' });
      if (room.order.length >= MAX_PLAYERS) return send(ws, { t: 'error', msg: 'This room is full: ' + MAX_PLAYERS + ' players.' });
      const want = cleanPiece(m.piece);
      const wantColor = Number.isInteger(Number(m.color)) && Number(m.color) >= 0 && Number(m.color) < COLORS ? Number(m.color) : null;
      p = { id: rid(6), token: rid(), name, piece: want && !pieceTaken(room, want, null) ? want : freePiece(room), color: wantColor != null && !colorTaken(room, wantColor, null) ? wantColor : freeColor(room), connected: true, ws: null };
      setPhoto(p, cleanPhoto(m.photo));
      room.players.set(p.id, p);
      room.order.push(p.id);
      fx(room, 'joined', { name: p.name, pid: p.id });
    }
    attach(ws, room, p);
    send(ws, { t: 'joined', code: room.code, token: p.token, id: p.id });
    return pushAll(room);
  }

  if (m.t === 'rejoin') {
    const room = rooms.get(clean(m.code, 4).toUpperCase());
    const p = room && [...room.players.values()].find(x => x.token === m.token);
    if (!p) return send(ws, { t: 'error', code: 'noroom', msg: 'That game has ended.', wait: !room && justStarted() });
    attach(ws, room, p);
    send(ws, { t: 'joined', code: room.code, token: p.token, id: p.id });
    return pushAll(room);
  }

  const room = ws.room;
  if (!room) return;

  if (ws.display) {
    if (!ws.admin) return;
    if (m.t === 'h') { adminAction(room, m); return pushAll(room); }
    if (m.t === 'save') {
      if (!room.game) return;
      try { send(ws, { t: 'saved', blob: packRoom(room, false, 'save'), info: saveInfo(room), label: clean(m.label, 30) }); } catch (e) { console.error('save error', e); }
      return;
    }
    return;
  }

  const p = room.players.get(ws.pid);
  if (!p) return;
  const g = room.game;

  switch (m.t) {
    case 'piece': {
      if (g) break;
      const pc = cleanPiece(m.piece);
      if (!pc) { send(ws, { t: 'error', msg: 'Pick one emoji.' }); break; }
      if (pieceTaken(room, pc, p)) { send(ws, { t: 'error', msg: 'Someone already has that one.' }); break; }
      p.piece = pc;
      setPhoto(p, null);                           // picking an emoji means "not my photo"
      break;
    }
    case 'photo': {
      if (g) break;
      if (m.data == null) { setPhoto(p, null); break; }
      const ph = cleanPhoto(m.data);
      if (!ph) { send(ws, { t: 'error', msg: "That photo didn't work. Try another one." }); break; }
      setPhoto(p, ph);
      break;
    }
    case 'color': {
      if (g) break;
      const n = Number(m.n);
      if (!Number.isInteger(n) || n < 0 || n >= COLORS) break;
      if (colorTaken(room, n, p)) { send(ws, { t: 'error', msg: 'Someone already has that color.' }); break; }
      p.color = n;
      break;
    }
    case 'chat': chat(room, p, m); break;
    case 'h':                                      // the captain's phone can start and restart
      if (captainId(room) !== p.id) break;
      if (m.a === 'start' || (m.a === 'lobby' && g && g.phase === 'gameOver')) adminAction(room, m);
      break;
    case 'roll': doRoll(room, p); break;
    case 'payJail': payJail(room, p); break;
    case 'useCard': useJailCard(room, p); break;
    case 'buy': buy(room, p); break;
    case 'decline': decline(room, p); break;
    case 'bid': bid(room, p, m.amount); break;
    case 'pass': passAuction(room, p); break;
    case 'build': build(room, p, Number(m.i)); break;
    case 'buildSet': buildSet(room, p, Number(m.i)); break;
    case 'sellSet': sellSet(room, p, Number(m.i)); break;
    case 'sell': sell(room, p, Number(m.i)); break;
    case 'mortgage': mortgage(room, p, Number(m.i)); break;
    case 'unmortgage': unmortgage(room, p, Number(m.i)); break;
    case 'trade': offerTrade(room, p, m); break;
    case 'tradeAnswer': answerTrade(room, p, m.id, !!m.accept); break;
    case 'tradeCancel': cancelTrade(room, p, m.id); break;
    case 'payDebt': payDebt(room, p); break;
    case 'bankrupt': declareBankruptcy(room, p); break;
    case 'leave': dropPlayer(room, p, false); break;
    default: return;
  }
  // Selling or mortgaging may have raised what a debt needed.
  if (room.game && room.game.phase === 'debt' && ['sell', 'mortgage', 'build', 'unmortgage'].includes(m.t)) { /* the player taps Pay when ready */ }
  pushAll(room);
}

function onClose(ws) {
  const room = ws.room;
  if (!room) return;
  if (ws.display) { room.displays.delete(ws); return; }
  const p = room.players.get(ws.pid);
  if (p && p.ws === ws) {
    p.connected = false; p.ws = null; p.goneAt = Date.now();
    if (!room.game) { const i = room.order.indexOf(p.id); if (i >= 0) room.order.splice(i, 1); room.players.delete(p.id); }
    pushAll(room);
  }
}

/* ------------------------------------------------------------- websocket */

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 512 * 1024 });

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    try { onMessage(ws, m); } catch (e) { console.error('message error', e); }
  });
  ws.on('close', () => { try { onClose(ws); } catch (e) { console.error('close error', e); } });
  ws.on('error', () => {});
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* ignore */ }
  }
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.touched > ROOM_IDLE_MS) { clearTimer(room); clearTimeout(room.endTimer); clearTimeout(room.backupTimer); clearTimeout(room.tidyTimer); clearTimeout(room.botTimer); rooms.delete(code); }
  }
}, 30000).unref();

setInterval(() => {
  for (const room of rooms.values()) { try { if (autoAct(room, false)) pushAll(room); } catch (e) { console.error('auto error', e); } }
}, 4000).unref();

if (require.main === module) {
  server.listen(PORT, () => console.log('Friend Monopoly server running on port ' + PORT));
  let stopping = false;
  const stop = () => {
    if (stopping) return; stopping = true;
    for (const room of rooms.values()) { try { clearTimeout(room.backupTimer); room.backupTimer = null; sendBackup(room); } catch (e) { /* keep going */ } }
    setTimeout(() => process.exit(0), 400);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

module.exports = { server, rooms, packRoom, unpackRoom, restoreRoom, loadRoom, rentFor, netWorth, PIECES, pushAll, cleanPiece, cleanPhoto, _t: { move, charge, settle, land } };
