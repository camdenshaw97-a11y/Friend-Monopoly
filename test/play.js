'use strict';
/*
 * Plays whole games against a real server with scripted screens: a TV and three player phones
 * that roll, buy, bid, build, trade and (when they must) go bankrupt. Checks the rules along the
 * way, that a timed game ends on net worth, that a game ends when one player is left, that a
 * saved game comes back, and that a game survives the server forgetting it.
 * The clocks run 40 times faster than in a real game.   Run with: npm test
 */
process.env.RESTORE_WINDOW_MS = '600000';
process.env.SPEED_UP = '40';
const WebSocket = require('ws');
const Boards = require('../boards');
const Cards = require('../cards');
const { server, rooms, rentFor, netWorth, cleanPiece, _t } = require('../server');

const PORT = 3997;
let failures = 0;
function check(name, ok, extra) {
  if (ok) console.log('  ok   ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}
const wait = ms => new Promise(r => setTimeout(r, ms));

class Screen {
  constructor(name) {
    this.name = name; this.state = null; this.msgs = []; this.last = {}; this.errors = [];
    this.ws = new WebSocket('ws://localhost:' + PORT + '/ws');
    this.ready = new Promise(res => this.ws.on('open', res));
    this.ws.on('message', raw => {
      const m = JSON.parse(raw);
      if (m.t === 'state') this.state = m.s;
      if (m.t === 'error') this.errors.push(m.msg);
      this.last[m.t] = m;
      this.msgs.push(m);
    });
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  async until(fn, ms = 4000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { try { if (fn(this.state, this.last)) return true; } catch (e) { /* not there yet */ } await wait(8); }
    return false;
  }
  close() { this.ws.close(); }
}

// A simple player: rolls, buys what it can comfortably afford, bids a little, pays its debts or goes under.
function act(p, seen) {
  const s = p.state; if (!s || !s.me || !s.game) return;
  const me = s.me, g = s.game;
  if (me.bankrupt) return;
  if (me.myTurn) {
    if (me.jail && me.canPayJail && me.jailTurns === 0) p.send({ t: 'payJail' });
    else p.send({ t: 'roll' });
    return;
  }
  if (me.offer != null) {
    const price = Boards.LAYOUT[me.offer].price;
    if (me.cash >= price + 250) { p.send({ t: 'buy' }); seen.buy = true; } else { p.send({ t: 'decline' }); seen.decline = true; }
    return;
  }
  if (me.inAuction && g.auction) {
    const a = g.auction;
    if (a.bidder !== me.id && a.bid < 60 && me.cash > 200 && p.name === 'Ann') { p.send({ t: 'bid', amount: a.bid + 20 }); seen.bid = true; }
    else if (a.bidder !== me.id) p.send({ t: 'pass' });
    return;
  }
  if (me.debt) {
    const d = me.debt;
    if (me.cash >= d.amount) { p.send({ t: 'payDebt' }); seen.paidDebt = true; return; }
    const mine = Object.keys(me.props || {}).map(Number);
    const sell = mine.find(i => !me.props[i].sell);
    if (sell != null) { p.send({ t: 'sell', i: sell }); return; }
    const mort = mine.find(i => !me.props[i].mortgage);
    if (mort != null) { p.send({ t: 'mortgage', i: mort }); seen.mortgage = true; return; }
    if (d.liquid < d.amount) { p.send({ t: 'bankrupt' }); seen.bankrupt = true; }
    return;
  }
  // Build when a whole set is owned and there is cash to spare.
  const buildable = Object.keys(me.props || {}).map(Number).find(i => !me.props[i].build && me.cash > 600);
  if (buildable != null && !me.myTurn && g.phase !== 'moving') { p.send({ t: 'build', i: buildable }); seen.build = true; }
}

async function playUntil(ps, tv, stop, maxMs, seen) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (stop(tv.state)) return true;
    for (const p of ps) act(p, seen);
    await wait(25);
  }
  return stop(tv.state);
}

async function main() {
  // ---- the data and the pure rules
  check('three built-in boards with 30 names each', Boards.THEMES.length === 3 && Boards.THEMES.every(t => Object.keys(t.names).length === 30));
  check('every board names every priced space', Boards.THEMES.every(t => Boards.NAMED.every(i => t.names[i])));
  check('40 spaces, 22 streets, 4 stations, 2 utilities', Boards.LAYOUT.length === 40 && Boards.LAYOUT.filter(s => s.t === 'prop').length === 22 && Boards.LAYOUT.filter(s => s.t === 'rail').length === 4 && Boards.LAYOUT.filter(s => s.t === 'util').length === 2);
  check('both decks have 16 Chance and 16 Community Chest cards', Cards.DECKS.every(d => d.cards.chance.length === 16 && d.cards.chest.length === 16));
  check('the two decks have the same effects', Cards.DECKS[0].cards.chance.every((c, i) => c.k === Cards.DECKS[1].cards.chance[i].k) && Cards.DECKS[0].cards.chest.every((c, i) => c.k === Cards.DECKS[1].cards.chest[i].k));
  const custom = Boards.customTheme({ name: 'Our Street', names: { 1: 'My House', 39: 'Your House' } });
  check('a custom board keeps classic names where it says nothing', custom && custom.names[1] === 'My House' && custom.names[3] === 'Baltic Avenue' && custom.names[39] === 'Your House');

  const spaces = Boards.build(Boards.THEMES[0]);
  const g0 = { spaces, props: { 1: { owner: 'a', h: 0, m: false }, 3: { owner: 'a', h: 0, m: false }, 5: { owner: 'b', h: 0, m: false }, 15: { owner: 'b', h: 0, m: false }, 12: { owner: 'c', h: 0, m: false }, 28: { owner: 'c', h: 0, m: false }, 39: { owner: 'a', h: 5, m: false }, 37: { owner: 'd', h: 0, m: false } } };
  check('rent doubles with the whole set', rentFor(g0, 1, 7) === 4 && rentFor(g0, 3, 7) === 8);
  check('rent without the set is plain', rentFor(g0, 37, 7) === 35);
  check('a hotel pays the hotel rent', rentFor(g0, 39, 7) === 2000);
  check('two stations pay $50, a card doubles it', rentFor(g0, 5, 7) === 50 && rentFor(g0, 5, 7, { rentMult: 2 }) === 100);
  check('both utilities pay 10x the dice; a card pays 10x too', rentFor(g0, 12, 7) === 70 && rentFor(g0, 12, 9, { utilDice: true }) === 90);
  const g1 = { spaces, players: { a: { cash: 100, bankrupt: false } }, props: { 1: { owner: 'a', h: 2, m: false }, 5: { owner: 'a', h: 0, m: true } } };
  check('net worth: cash + price (mortgaged at half) + houses at cost', netWorth(g1, 'a') === 100 + 60 + 100 + 100);
  check('a piece is one emoji', cleanPiece('🦖') === '🦖' && cleanPiece('🇺🇸') === '🇺🇸' && cleanPiece('👍🏽') === '👍🏽' && cleanPiece('ab') === null && cleanPiece('🦖🦖') === null && cleanPiece('x') === null && cleanPiece('') === null);

  await new Promise(res => server.listen(PORT, res));
  console.log('server up on ' + PORT);

  /* =============================== game 1: a timed game, played by the bots */
  const tv = new Screen('tv'); await tv.ready;
  tv.send({ t: 'create', custom: { boards: [{ name: 'Our Street', names: { 1: 'My House' } }] } });
  check('room created', await tv.until((s, l) => l.created && s));
  const code = tv.last.created.code, token = tv.last.created.token;
  check('the custom board is on offer', tv.state.themes.some(t => t.id === 'custom:our-street'));
  const ps = [];
  for (const n of ['Ann', 'Ben', 'Cal']) { const p = new Screen(n); await p.ready; p.send({ t: 'join', code, name: n }); ps.push(p); }
  for (const p of ps) check(p.name + ' joined', await p.until((s, l) => l.joined && s));
  const [ann, ben, cal] = ps;
  const id = p => p.state.me.id;
  check('three players, Ann is captain, every piece different', await tv.until(s => s.players.length === 3 && s.captain === id(ann) && new Set(s.players.map(p => p.piece)).size === 3));
  ben.send({ t: 'piece', piece: ann.state.me.piece });
  await wait(60);
  check("you can't take someone's piece", ben.state.me.piece !== ann.state.me.piece && ben.errors.length === 1);
  ben.send({ t: 'piece', piece: '🍕' });
  check('any emoji can be a piece', await ben.until(s => s.me.piece === '🍕'));
  ben.send({ t: 'piece', piece: 'hi' });
  await wait(60);
  check('a word is not a piece', ben.state.me.piece === '🍕');
  check('everyone gets a different color', new Set(tv.state.players.map(p => p.color)).size === 3);
  ben.send({ t: 'color', n: ann.state.me.color });
  await wait(60);
  check("you can't take someone's color", ben.state.me.color !== ann.state.me.color);
  ben.send({ t: 'color', n: 7 });
  check('a free color can be picked', await ben.until(s => s.me.color === 7 && s.players.find(p => p.id === id(ben)).color === 7));
  // a private chat
  ann.send({ t: 'chat', to: id(ben), text: 'sell me baltic later?' });
  check('a message reaches the other phone', await ben.until(s => s.me.chats && s.me.chats[id(ann)] && s.me.chats[id(ann)][0].text === 'sell me baltic later?'));
  await wait(40);
  check('and nobody else', !cal.state.me.chats[id(ann)] && !cal.state.me.chats[id(ben)] && !JSON.stringify(tv.state).includes('baltic later'));
  ann.send({ t: 'h', a: 'settings', mode: 'last' });
  await wait(60);
  check('a phone cannot change the setup', tv.state.settings.mode === 'timer');
  tv.send({ t: 'h', a: 'settings', theme: 'sandiego', deck: 'latenight', mode: 'timer', minutes: 5, turnSecs: 30, auctionSecs: 10 });
  check('the TV sets up the game', await tv.until(s => s.settings.theme === 'sandiego' && s.settings.deck === 'latenight' && s.settings.minutes === 5 && s.settings.turnSecs === 30 && s.settings.auctionSecs === 10));
  check('the board names follow the theme', tv.state.names[39] === 'La Jolla' && tv.state.names[5] === 'Blue Line');

  const late = new Screen('Late'); await late.ready;
  tv.send({ t: 'h', a: 'start' });
  check('the game starts with the roll for first', await tv.until(s => s.phase === 'rolloff' && s.game && s.game.rolloff));
  late.send({ t: 'join', code, name: 'Late' });
  await late.until((s, l) => l.error, 1500);
  check('nobody new can join once it has started', late.errors.length === 1 && /already started/.test(late.errors[0]));
  late.close();
  check('everyone starts with $1,500 at GO', Object.values(tv.state.game.players).every(p => p.cash === 1500 && p.pos === 0));
  check('a turn begins', await tv.until(s => s.phase === 'turn' && s.game.cur, 3000));
  const first = tv.state.game.cur;
  check('the first player is the one who rolled highest', tv.state.game.order[0] === first);
  const firstPhone = ps.find(p => id(p) === first);
  check("it's their turn on their phone", await firstPhone.until(s => s.me.myTurn && s.me.canRoll));
  check('the turn clock is showing', tv.state.game.clock && tv.state.game.clock.what === 'auto');
  const other = ps.find(p => id(p) !== first);
  other.send({ t: 'roll' });
  await wait(60);
  check("nobody else can roll", tv.state.phase === 'turn');
  firstPhone.send({ t: 'roll' });
  check('a roll moves the token', await tv.until(s => s.phase === 'moving' && s.game.roll.d1 >= 1 && s.game.players[first].pos === (s.game.roll.d1 + s.game.roll.d2) % 40));

  const before = tv.state.game.timeLeft;
  tv.send({ t: 'h', a: 'addTime', minutes: 5 });
  check('the TV can add time to the clock', await tv.until(s => s.game.timeLeft > before + 5 * 60000 / 40 - 2000));
  ann.send({ t: 'h', a: 'addTime', minutes: 10 });
  await wait(60);
  check('a phone cannot', tv.state.game.timeLeft < before + 15 * 60000 / 40 - 2000);
  const seen = {};
  const rolledTurns = await playUntil(ps, tv, s => s.game && s.game.turnCount >= 8, 8000, seen);
  check('the bots play eight turns', rolledTurns, 'phase ' + tv.state.phase);
  check('a property got bought or sent to auction', seen.buy || seen.decline);

  // ---- building, mortgaging and trading, set up directly on the room
  const room = rooms.get(code), G = () => room.game;
  const [A, Bn, C] = [id(ann), id(ben), id(cal)];
  const prop = (i, owner, h, m) => { G().props[i] = { owner, h: h || 0, m: !!m }; };
  prop(1, A); prop(3, A); prop(6, Bn); prop(8, Bn); prop(9, A);
  G().players[A].cash = 2000; G().players[Bn].cash = 300;
  require('../server').pushAll(room);
  await ann.until(s => s.me.props && s.me.props[1]);
  check('build is allowed on a full set', ann.state.me.props[1].build === null);
  check('build is refused without the full set', /whole color group/.test(ann.state.me.props[9].build));
  ann.send({ t: 'build', i: 1 });
  check('a house goes up and $50 is paid', await tv.until(s => s.game.props[1].h === 1 && s.game.players[A].cash === 1950 && s.game.bank.houses === 31));
  ann.send({ t: 'build', i: 1 });
  await wait(60);
  check('a second house on the same street must wait (even building)', G().props[1].h === 1 && /evenly/.test(ann.errors[ann.errors.length - 1]));
  ann.send({ t: 'build', i: 3 });
  await tv.until(s => s.game.props[3].h === 1);
  for (let k = 0; k < 6; k++) { ann.send({ t: 'build', i: k % 2 ? 3 : 1 }); await tv.until(s => s.game.props[k % 2 ? 3 : 1].h >= Math.ceil((k + 2) / 2)); }
  ann.send({ t: 'build', i: 1 });
  check('four houses become a hotel', await tv.until(s => s.game.props[1].h === 5 && s.game.bank.hotels === 11), 'h=' + G().props[1].h);
  check('the house count makes sense (one hotel, four houses on the other street)', G().bank.hotels === 11 && G().bank.houses === 32 - 4);
  ann.send({ t: 'mortgage', i: 1 });
  await wait(60);
  check("a street with buildings can't be mortgaged", !G().props[1].m);
  ann.send({ t: 'sell', i: 3 });
  await wait(60);
  check('selling must come down evenly too', G().props[3].h === 4);
  ann.send({ t: 'sell', i: 1 });
  check('a hotel sells back to four houses for half a house', await tv.until(s => s.game.props[1].h === 4 && s.game.bank.hotels === 12));
  // building across the set from one tap: 1 has 4, 3 has 4 after the hotel sale
  ann.send({ t: 'buildSet', i: 3 });
  check('build-on-the-set puts the next house where it belongs (a hotel on the first street)', await tv.until(s => s.game.props[1].h === 5 && s.game.props[3].h === 4));
  ann.send({ t: 'buildSet', i: 1 });
  check('and then on the other', await tv.until(s => s.game.props[3].h === 5));
  ann.send({ t: 'buildSet', i: 1 });
  await wait(60);
  check('nothing left to build on a full set', G().props[1].h === 5 && G().props[3].h === 5 && /hotel/i.test(ann.errors[ann.errors.length - 1]));
  ann.send({ t: 'sellSet', i: 3 });
  check('sell-from-the-set takes from the fullest street', await tv.until(s => (s.game.props[1].h === 4) !== (s.game.props[3].h === 4) && (s.game.props[1].h === 5 || s.game.props[3].h === 5)));
  ann.send({ t: 'sellSet', i: 3 });
  check('then evens it out', await tv.until(s => s.game.props[1].h === 4 && s.game.props[3].h === 4));
  check('the phone is told which street is next', ann.state.me.props[1].buildNext === 1 || ann.state.me.props[1].buildNext === 3);
  ann.send({ t: 'sell', i: 1 });
  await tv.until(s => s.game.props[1].h === 3);
  for (let k = 0; k < 7; k++) { ann.send({ t: 'sellSet', i: 1 }); await wait(40); }
  await tv.until(s => s.game.props[1].h === 0 && s.game.props[3].h === 0);
  check('the houses are all back in the bank', G().bank.houses === 32 && G().bank.hotels === 12);
  ann.send({ t: 'build', i: 1 });
  await tv.until(s => s.game.props[1].h === 1);
  const cashBefore = G().players[A].cash;
  ann.send({ t: 'mortgage', i: 9 });
  check('mortgaging pays half the price', await tv.until(s => s.game.props[9].m && s.game.players[A].cash === cashBefore + 60));
  ann.send({ t: 'unmortgage', i: 9 });
  check('lifting it costs 10% more', await tv.until(s => !s.game.props[9].m && s.game.players[A].cash === cashBefore + 60 - 66));
  check('the TV never sees a phone-only field', !JSON.stringify(tv.state).includes('"myTurn"'));

  // trading
  ann.send({ t: 'trade', to: Bn, give: { props: [1], cash: 0 }, get: { props: [6], cash: 100 } });
  await wait(80);
  check("a street with buildings can't be traded", G().trades.length === 0 && /buildings/.test(ann.errors[ann.errors.length - 1]));
  ann.send({ t: 'trade', to: Bn, give: { props: [9], cash: 50 }, get: { props: [6], cash: 0 } });
  check('an offer reaches the other phone', await ben.until(s => s.game.trades.some(t => t.from === A && t.to === Bn && t.give.props[0] === 9 && t.give.cash === 50)));
  const tid = ben.state.game.trades[0].id;
  cal.send({ t: 'tradeAnswer', id: tid, accept: true });
  await wait(60);
  check("only the other party can accept", G().trades.length === 1);
  const aCash = G().players[A].cash, bCash = G().players[Bn].cash;
  ben.send({ t: 'tradeAnswer', id: tid, accept: true });
  check('accepting swaps the properties and the cash', await tv.until(s => s.game.props[9].owner === Bn && s.game.props[6].owner === A && s.game.players[A].cash === aCash - 50 && s.game.players[Bn].cash === bCash + 50 && s.game.trades.length === 0));

  // a saved game comes back, in a new room, for the same names
  tv.send({ t: 'save', label: 'Test night' });
  check('the TV gets a sealed save', await tv.until((s, l) => l.saved && l.saved.blob && l.saved.info.players.length === 3));
  const saveBlob = tv.last.saved.blob, savedCash = G().players[A].cash, savedTurn = G().turnCount;
  const tv2 = new Screen('tv2'); await tv2.ready;
  tv2.send({ t: 'load', blob: saveBlob });
  check('the save opens as a new room', await tv2.until((s, l) => l.created && l.created.loaded && s && s.code !== code));
  const code2 = tv2.last.created.code;
  const ann2 = new Screen('Ann2'); await ann2.ready;
  ann2.send({ t: 'join', code: code2, name: 'Ann' });
  check('Ann gets her seat back by name', await ann2.until(s => s.me && s.me.name === 'ANN' && s.me.cash === savedCash && s.game.turnCount === savedTurn));
  const stranger = new Screen('Zed'); await stranger.ready;
  stranger.send({ t: 'join', code: code2, name: 'Zed' });
  await stranger.until((s, l) => l.error, 1500);
  check('a new name cannot join a loaded game', stranger.errors.length === 1);
  stranger.close(); ann2.close(); tv2.close();
  rooms.delete(code2);

  // the server forgets the room; the TV hands back its sealed copy
  check('the TV has a backup', await tv.until((s, l) => l.backup && l.backup.code === code));
  const backup = tv.last.backup.blob;
  const old = rooms.get(code);
  rooms.delete(code);
  clearTimeout(old.timer); clearTimeout(old.endTimer);
  tv.send({ t: 'restore', code, token, blob: backup, idle: 0 });
  check('the room is restored', await tv.until((s, l) => l.watching && l.watching.restored));
  const inBackup = require('../server').unpackRoom(backup).game;
  check('with everyone\'s money where it was', tv.state.game.players[A].cash === inBackup.players[A].cash && rooms.get(code) !== old);
  for (const p of ps) { const tok = p.last.joined.token; p.last = {}; p.send({ t: 'rejoin', code, token: tok }); }
  check('the phones rejoin with their old tokens', await ann.until((s, l) => l.joined && s.game && s.me.cash === s.game.players[A].cash));
  const room2 = rooms.get(code);

  // time runs out: ranked by net worth
  const ended = await playUntil(ps, tv, s => s.phase === 'gameOver', 30000, seen);
  check('the timed game ends', ended, 'phase ' + tv.state.phase);
  check("it ended because time ran out (or everyone but one went broke first)", tv.state.game.why === 'time' || tv.state.game.why === 'last', tv.state.game.why);
  const rk = tv.state.game.ranking;
  const live = rk.filter(r => !r.out), gone = rk.filter(r => r.out);
  check('the living are ranked by net worth', live.every((r, i) => i === 0 || live[i - 1].net >= r.net));
  check('the bankrupt sit below them, last out first', gone.every((r, i) => i === 0 || gone[i - 1].out >= r.out) && rk.every((r, i) => (i < live.length) === !r.out));
  check('the winner is announced', tv.state.game.winner === rk[0].id);
  check('awards are handed out', (tv.state.game.awards || []).length >= 1);
  check('a phone knows its place', await ann.until(s => s.me.place >= 1));
  room2.game = null;

  /* =============================== game 2: last one standing, with a forced bankruptcy */
  const tvB = new Screen('tvB'); await tvB.ready;
  tvB.send({ t: 'create', custom: {} });
  await tvB.until((s, l) => l.created);
  const codeB = tvB.last.created.code;
  const qs = [];
  for (const n of ['Dee', 'Eli']) { const p = new Screen(n); await p.ready; p.send({ t: 'join', code: codeB, name: n }); qs.push(p); }
  for (const p of qs) await p.until((s, l) => l.joined && s);
  const [dee, eli] = qs;
  tvB.send({ t: 'h', a: 'settings', mode: 'last', turnSecs: 0 });
  await tvB.until(s => s.settings.mode === 'last');
  tvB.send({ t: 'h', a: 'start' });
  check('a two-player game starts', await tvB.until(s => s.phase === 'turn', 3000));
  const rb = rooms.get(codeB), gb = rb.game, D = id(dee), E = id(eli);
  check('no clock in a game with the turn clock off', !gb.clock);
  // Eli lands on Dee's hotel with $50 in hand and nothing to sell.
  gb.props[39] = { owner: D, h: 5, m: false };
  gb.players[E].cash = 50; gb.players[E].pos = 37;
  gb.players[E].cards.chance = true;
  gb.cur = E; gb.phase = 'turn'; gb.roll = { n: 0 };
  _t.move(rb, E, 2, { kind: 'roll' });
  require('../server').pushAll(rb);
  check('Eli owes rent he cannot pay', await eli.until(s => s.phase === 'debt' && s.me.debt && s.me.debt.amount === 2000 && s.me.debt.to === D, 3000));
  eli.send({ t: 'payDebt' });
  await wait(60);
  check("he can't pay what he doesn't have", gb.phase === 'debt' && /need/.test(eli.errors[eli.errors.length - 1]));
  check('his phone offers bankruptcy', eli.state.me.debt.liquid < eli.state.me.debt.amount);
  dee.send({ t: 'bankrupt' });
  await wait(60);
  check('only the debtor can declare it', gb.phase === 'debt');
  eli.send({ t: 'bankrupt' });
  check('Eli goes bankrupt and Dee gets his cash and his card', await tvB.until(s => s.game.players[E].bankrupt && s.game.players[D].cards === 1 && s.game.players[D].cash === 1500 + 50));
  check('the last one standing wins', await tvB.until(s => s.phase === 'gameOver' && s.game.why === 'last' && s.game.winner === D));
  check('the ranking puts Eli last as first out', tvB.state.game.ranking[1].id === E && tvB.state.game.ranking[1].out === 1);
  dee.send({ t: 'h', a: 'lobby' });
  check('the captain can go back to the lobby for another game', await tvB.until(s => s.phase === 'lobby'));

  /* =============================== game 3: jail, cards and an away player, on the room directly */
  tvB.send({ t: 'h', a: 'settings', mode: 'last' });
  tvB.send({ t: 'h', a: 'start' });
  await tvB.until(s => s.phase === 'turn', 3000);
  const r3 = rooms.get(codeB), g3 = r3.game;
  const cur = g3.cur, oth = g3.order.find(x => x !== cur), curPhone = qs.find(p => id(p) === cur);
  g3.players[cur].pos = 28;
  _t.move(r3, cur, 2, { kind: 'roll' });   // lands on Go to Jail
  check('landing on Go to Jail jails you', await tvB.until(s => s.game.players[cur].jail && s.game.players[cur].pos === 10, 2000));
  check("and the turn passes", await tvB.until(s => s.phase === 'turn' && s.game.cur === oth, 2000));
  // the other player lands on their own street, so nothing happens and the turn comes back round
  g3.props[1] = { owner: oth, h: 0, m: false };
  g3.players[oth].pos = 0; g3.roll = { d1: 1, d2: 0, dbl: false, n: 0 };
  _t.move(r3, oth, 1, { kind: 'roll' });
  check("the jailed player's turn comes round", await curPhone.until(s => s.me.myTurn && s.me.jail && s.me.canPayJail, 3000));
  curPhone.send({ t: 'payJail' });
  check('paying the fine frees you and you still roll', await tvB.until(s => !s.game.players[cur].jail && s.game.players[cur].cash === 1450 && s.phase === 'turn' && s.game.cur === cur));
  // a card: "advance to GO" pays $200
  g3.players[cur].pos = 36;
  const deck = Cards.deckById(g3.deck).cards.chance;
  g3.decks.chance.unshift(deck.findIndex(c => c.k === 'move' && c.to === 0));
  g3.players[cur].pos = 34; g3.roll = { d1: 1, d2: 1, dbl: false, n: 0 };
  _t.move(r3, cur, 2, { kind: 'roll' });
  check('landing on Chance draws a card', await tvB.until(s => s.phase === 'card' && s.game.card && /GO/.test(s.game.card.text), 2000));
  check('advance to GO collects exactly $200', await tvB.until(s => s.game.players[cur].pos === 0 && s.game.players[cur].cash === 1450 + 200, 3000));
  // an away player: the game rolls for them
  await tvB.until(s => s.phase === 'turn', 3000);
  const away = qs.find(p => id(p) === r3.game.cur);
  away.close();
  check('the game rolls for a phone that has gone', await tvB.until(s => s.game.log.some(l => /away/.test(l.text)), 8000));

  /* =============================== game 4: bots play against each other */
  const tvC = new Screen('tvC'); await tvC.ready;
  tvC.send({ t: 'create', custom: {} });
  await tvC.until((s, l) => l.created);
  for (let k = 0; k < 4; k++) tvC.send({ t: 'h', a: 'addBot' });
  check('the TV adds four bots', await tvC.until(s => s.players.length === 4 && s.players.every(p => p.bot) && new Set(s.players.map(p => p.piece)).size === 4));
  tvC.send({ t: 'h', a: 'removeBot' });
  check('and can take one away', await tvC.until(s => s.players.length === 3));
  tvC.send({ t: 'h', a: 'settings', mode: 'last', auctionSecs: 10 });
  tvC.send({ t: 'h', a: 'start' });
  check('a bot game starts', await tvC.until(s => s.phase === 'turn', 4000));
  check('bots play by themselves', await tvC.until(s => s.game.turnCount >= 12 && Object.keys(s.game.props).length >= 2, 20000), 'turn ' + (tvC.state.game && tvC.state.game.turnCount));
  tvC.send({ t: 'h', a: 'endGame' });
  await tvC.until(s => s.phase === 'gameOver');

  /* =============================== game 5: leaving mid-game */
  const tvD = new Screen('tvD'); await tvD.ready;
  tvD.send({ t: 'create', custom: {} });
  await tvD.until((s, l) => l.created);
  const codeD = tvD.last.created.code;
  const rs = [];
  for (const n of ['Rae', 'Sid', 'Tom']) { const p = new Screen(n); await p.ready; p.send({ t: 'join', code: codeD, name: n }); rs.push(p); }
  for (const p of rs) await p.until((s, l) => l.joined && s);
  tvD.send({ t: 'h', a: 'settings', mode: 'last', turnSecs: 0 });
  await tvD.until(s => s.settings.mode === 'last');
  tvD.send({ t: 'h', a: 'start' });
  await tvD.until(s => s.phase === 'turn', 3000);
  const rD = rooms.get(codeD), gD = rD.game;
  const mover = gD.cur, leaver = gD.order.find(x => x !== mover), third = gD.order.find(x => x !== mover && x !== leaver);
  const leaverPhone = rs.find(p => id(p) === leaver), moverPhone = rs.find(p => id(p) === mover);
  gD.props[39] = { owner: leaver, h: 0, m: false }; gD.props[37] = { owner: leaver, h: 0, m: false };
  // the mover's piece is walking when someone else leaves
  gD.players[mover].pos = 0; gD.roll = { d1: 3, d2: 1, dbl: false, n: 0 };
  _t.move(rD, mover, 4, { kind: 'roll' });
  require('../server').pushAll(rD);
  await tvD.until(s => s.phase === 'moving');
  leaverPhone.send({ t: 'leave' });
  check('the leaver is told they left', await leaverPhone.until((s, l) => l.left));
  check('they are out, marked as left', await tvD.until(s => s.game.players[leaver].bankrupt && s.game.players[leaver].left));
  check("someone else's move carries on", await tvD.until(s => s.game.log.some(l => /lands on Income Tax/.test(l.text)), 3000));
  check("the leaver's properties go up for auction after it", await tvD.until(s => s.phase === 'auction' && [37, 39].includes(s.game.auction.space), 6000));
  for (const p of rs.filter(p => id(p) !== leaver)) p.send({ t: 'pass' });
  await tvD.until(s => s.phase === 'auction' && s.game.auction.space !== tvD.state.game.auction.space || s.phase !== 'auction', 4000);
  for (const p of rs.filter(p => id(p) !== leaver)) p.send({ t: 'pass' });
  check('then the game goes on to the next player', await tvD.until(s => s.phase === 'turn' && s.game.cur !== leaver, 8000));
  // now the player whose turn it is leaves: a two-player game ends
  const curNow = tvD.state.game.cur, nowPhone = rs.find(p => id(p) === curNow);
  nowPhone.send({ t: 'leave' });
  check('when only one is left, they win', await tvD.until(s => s.phase === 'gameOver' && s.game.why === 'last' && s.game.winner !== curNow && s.game.winner !== leaver, 4000));
  check('the ranking says who left', tvD.state.game.ranking.filter(r => r.left).length === 2);
  void third; void moverPhone;

  console.log(failures ? failures + ' FAILED' : 'all good');
  for (const p of [tv, tvB, tvC, tvD, ...ps, ...qs, ...rs]) { try { p.close(); } catch (e) { /* already closed */ } }
  server.close();
  for (const r of rooms.values()) { clearTimeout(r.timer); clearTimeout(r.endTimer); clearTimeout(r.backupTimer); clearTimeout(r.tidyTimer); clearTimeout(r.botTimer); }
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
