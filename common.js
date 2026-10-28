/* Shared by the TV page and the phone page. */
(function () {
  'use strict';
  var F = window.Game = {};

  // Change this to rename the game everywhere.
  F.TITLE = 'FRIEND MONOPOLY';
  // Shown small on the start screens. Goes up with every change; CHANGELOG.md says what each one was.
  F.VERSION = '1.5';

  F.$ = function (sel, root) { return (root || document).querySelector(sel); };
  F.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  F.money = function (n) { n = Number(n) || 0; return (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US'); };
  F.plural = function (n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); };
  F.clock = function (ms) {
    var s = Math.max(0, Math.ceil(ms / 1000)), m = Math.floor(s / 60), h = Math.floor(m / 60);
    s = s % 60; m = m % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s;
  };

  // Each player keeps a color for the whole game.
  F.COLORS = [['#ff5a4e', '#c4231a'], ['#ffd23f', '#d69a00'], ['#3d8bff', '#1a4fc4'], ['#3fd47a', '#1b9450'], ['#b26bff', '#7a2fd6'], ['#ff9a3d', '#d0610c'], ['#ff6fb5', '#cc2f7f'], ['#2fd6d0', '#11908b']];

  F.store = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* private mode */ } }
  };

  /* ---- live connection with automatic reconnect ---- */
  F.connect = function (opts) {
    var ws = null, timer = null, tries = 0, stopped = false;
    var myBuild = document.documentElement.getAttribute('data-build');
    function freshCheck() {
      if (!myBuild || !window.fetch) return;
      fetch('/version', { cache: 'no-store' }).then(function (r) { return r.ok ? r.text() : ''; }).then(function (v) {
        if (!/^[0-9a-f]{12}$/.test(v) || v === myBuild) return;
        var last = Number(F.store.get('mon.reloadAt', 0));
        if (Date.now() - last < 30000) return;
        F.store.set('mon.reloadAt', Date.now());
        try { sessionStorage.setItem('mon.auto', '1'); } catch (e) { /* private mode */ }
        location.reload();
      }).catch(function () { /* offline: try again next time */ });
    }
    function open() {
      timer = null;
      if (stopped) return;
      try {
        ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
      } catch (e) { return retry(); }
      var mine = ws;
      mine.onopen = function () {
        tries = 0;
        freshCheck();
        if (opts.onStatus) opts.onStatus(true);
        var h = opts.hello && opts.hello();
        if (h) mine.send(JSON.stringify(h));
      };
      mine.onmessage = function (e) {
        var m; try { m = JSON.parse(e.data); } catch (err) { return; }
        opts.onMessage(m);
      };
      mine.onclose = function () {
        if (ws !== mine) return;
        if (opts.onStatus) opts.onStatus(false);
        retry();
      };
      mine.onerror = function () { try { mine.close(); } catch (e) { /* ignore */ } };
    }
    function retry() {
      if (stopped || timer) return;
      timer = setTimeout(open, Math.min(4000, 300 + 500 * tries++));
    }
    var api = {
      send: function (m) {
        if (ws && ws.readyState === 1) { ws.send(JSON.stringify(m)); return true; }
        return false;
      },
      stop: function () { stopped = true; if (timer) clearTimeout(timer); try { ws.close(); } catch (e) { /* ignore */ } }
    };
    open();
    setInterval(function () { api.send({ t: 'ping' }); }, 20000);
    setInterval(function () { try { fetch('/health').catch(function () {}); freshCheck(); } catch (e) { /* ignore */ } }, 4 * 60 * 1000);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && !stopped && (!ws || ws.readyState > 1)) {
        if (timer) { clearTimeout(timer); timer = null; }
        tries = 0; open();
      }
    });
    return api;
  };

  /* ---- keep the screen awake while the game is open ---- */
  F.stayAwake = function () {
    var lock = null;
    function ask() {
      if (!navigator.wakeLock || document.hidden) return;
      try { navigator.wakeLock.request('screen').then(function (l) { lock = l; }).catch(function () {}); } catch (e) { /* not allowed here */ }
    }
    ask();
    document.addEventListener('visibilitychange', function () { if (!document.hidden) ask(); });
    document.addEventListener('click', function () { if (!lock) ask(); }, { passive: true });
  };

  /* ---- shrink text until it fits ---- */
  F.fit = function (el, min) {
    el.style.fontSize = '';
    var size = parseFloat(getComputedStyle(el).fontSize);
    var floor = min || size * 0.45;
    var guard = 0;
    while (el.scrollWidth > el.clientWidth + 1 && size > floor && guard++ < 60) {
      size -= Math.max(1, size * 0.05);
      el.style.fontSize = size + 'px';
    }
  };

  /* ---- motion helpers ---- */
  var calm = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  F.motionOK = function () { return !(calm && calm.matches); };
  F.anim = function (el, frames, opts) {
    if (!el || !el.animate || !F.motionOK()) return null;
    try { return el.animate(frames, opts); } catch (e) { return null; }
  };
  F.bump = function (el, scale) {
    return F.anim(el, [{ transform: 'scale(1)' }, { transform: 'scale(' + (scale || 1.2) + ')', offset: 0.4 }, { transform: 'scale(1)' }],
      { duration: 380, easing: 'cubic-bezier(.3, 1.3, .5, 1)' });
  };
  F.shake = function (el) {
    return F.anim(el, [0, -6, 12, -18, 18, -14, 12, -8, 4, 0].map(function (x) { return { transform: 'translateX(' + x + 'px)' }; }), { duration: 480, easing: 'ease-out' });
  };

  /* ---- redraw a block of HTML without throwing away what is already on screen ----
     data-key="..." (or an id) marks an element as "the same one" between redraws.
     data-live means "leave my contents alone": a script is animating them. */
  function keyOf(n) { return n.nodeType === 1 ? (n.getAttribute('data-key') || n.id || null) : null; }
  function morphKids(from, to) {
    var want = {}, cur = from.firstChild, next = to.firstChild, n, k, hit, c, clear;
    function id(x) { var kk = keyOf(x); return kk ? x.nodeName + '|' + kk : null; }
    function drop(x) { if (x === cur) cur = cur.nextSibling; from.removeChild(x); }
    for (n = to.firstChild; n; n = n.nextSibling) if (id(n)) want[id(n)] = 1;
    while (next) {
      n = next; next = next.nextSibling;
      while (cur && id(cur) && !want[id(cur)]) drop(cur);
      k = id(n); hit = null;
      for (c = cur; c; c = c.nextSibling) if (k ? id(c) === k : (!id(c) && c.nodeName === n.nodeName)) { hit = c; break; }
      if (hit && hit !== cur) {
        clear = true;
        for (c = cur; c !== hit; c = c.nextSibling) if (id(c) && want[id(c)]) { clear = false; break; }
        if (clear) while (cur !== hit) drop(cur);
      }
      if (hit) {
        if (hit === cur) cur = cur.nextSibling; else from.insertBefore(hit, cur);
        morphNode(hit, n);
      } else from.insertBefore(n, cur);
    }
    while (cur) drop(cur);
  }
  function morphNode(a, b) {
    if (a.nodeType !== 1) { if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue; return; }
    var i, at, name;
    for (i = a.attributes.length - 1; i >= 0; i--) {
      name = a.attributes[i].name;
      if (!b.hasAttribute(name) && name.indexOf('data-fx-') !== 0) a.removeAttribute(name);
    }
    for (i = 0; i < b.attributes.length; i++) {
      at = b.attributes[i];
      if (a.getAttribute(at.name) !== at.value) a.setAttribute(at.name, at.value);
    }
    if (a.nodeName === 'INPUT' || a.nodeName === 'TEXTAREA' || a.nodeName === 'SELECT') {
      if (document.activeElement !== a) { var v = b.getAttribute('value') || ''; if (a.value !== v) a.value = v; }
      return;
    }
    if (a.hasAttribute('data-live')) return;
    morphKids(a, b);
  }
  F.morph = function (root, html) {
    var t = document.createElement('template');
    t.innerHTML = html;
    morphKids(root, t.content);
  };

  /* ---- count a number up or down ---- */
  F.countTo = function (el, to, ms, fmt) {
    fmt = fmt || F.money;
    var from = el._n == null ? to : el._n;
    el._n = to;
    if (el._raf) cancelAnimationFrame(el._raf);
    if (from === to || !ms || !F.motionOK()) { el.textContent = fmt(to); return; }
    var t0 = performance.now();
    (function step(now) {
      var k = Math.min(1, (now - t0) / ms);
      el.textContent = fmt(Math.round(from + (to - from) * k));
      if (k < 1) el._raf = requestAnimationFrame(step);
    })(t0);
  };

  /* Buttons stay pressed for a beat even on a quick tap, so every tap is felt. */
  F.pressFx = function () {
    var held = null, t0 = 0;
    function release() {
      var b = held; held = null;
      if (b) setTimeout(function () { b.removeAttribute('data-fx-press'); }, Math.max(0, 110 - (performance.now() - t0)));
    }
    document.addEventListener('pointerdown', function (e) {
      var b = e.target.closest ? e.target.closest('button, a.tvbtn, a.link') : null;
      if (!b || b.disabled) return;
      if (held && held !== b) held.removeAttribute('data-fx-press');
      held = b; t0 = performance.now();
      b.setAttribute('data-fx-press', '');
    }, { passive: true });
    ['pointerup', 'pointercancel', 'blur'].forEach(function (ev) { addEventListener(ev, release, { passive: true }); });
    document.addEventListener('touchstart', function () {}, { passive: true });
  };


  /* ---- dialogs styled like the game (instead of the browser's own) ----
     F.dialog({ title, text, buttons: [{ label, kind, value }], input: { placeholder, value, maxlength } })
     resolves with the button's value (and, with an input, { value, text }). */
  F.dialog = function (o) {
    return new Promise(function (resolve) {
      var back = document.createElement('div');
      back.className = 'dlg-back';
      var h = '<div class="dlg" role="dialog">' + (o.title ? '<h2>' + F.esc(o.title) + '</h2>' : '') + (o.text ? '<p>' + F.esc(o.text) + '</p>' : '');
      if (o.input) h += '<input class="dlg-in" maxlength="' + (o.input.maxlength || 40) + '" placeholder="' + F.esc(o.input.placeholder || '') + '" value="' + F.esc(o.input.value || '') + '">';
      h += '<div class="dlg-row">' + (o.buttons || [{ label: 'OK', kind: 'pri', value: true }]).map(function (b, i) { return '<button class="dlg-btn ' + (b.kind || '') + '" data-i="' + i + '">' + F.esc(b.label) + '</button>'; }).join('') + '</div></div>';
      back.innerHTML = h;
      document.body.appendChild(back);
      var inp = back.querySelector('.dlg-in');
      function done(v) { back.classList.add('out'); setTimeout(function () { back.remove(); }, 180); resolve(v); }
      back.addEventListener('click', function (e) {
        var b = e.target.closest('.dlg-btn');
        if (b) { var bt = (o.buttons || [{ value: true }])[Number(b.getAttribute('data-i'))]; done(inp ? { value: bt.value, text: inp.value } : bt.value); }
        else if (e.target === back && !o.input) done(o.cancel === undefined ? false : o.cancel);
      });
      if (inp) { setTimeout(function () { inp.focus(); inp.select(); }, 60); inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { var pri = (o.buttons || []).findIndex(function (b) { return b.kind === 'pri'; }); done({ value: pri >= 0 ? o.buttons[pri].value : true, text: inp.value }); } }); }
      addEventListener('keydown', function esc(e) { if (e.key === 'Escape' && back.parentNode) { done(o.cancel === undefined ? false : o.cancel); removeEventListener('keydown', esc); } });
    });
  };
  F.confirm = function (title, text, okLabel, danger) {
    return F.dialog({ title: title, text: text, buttons: [{ label: okLabel || 'OK', kind: danger ? 'red' : 'pri', value: true }, { label: 'Cancel', kind: 'ghost', value: false }] });
  };

  /* ---- sound effects, synthesized so there are no audio files to load ---- */
  F.sfx = (function () {
    var ctx = null, muted = false, master = null;
    function ac() {
      if (!ctx) {
        var C = window.AudioContext || window.webkitAudioContext;
        if (C) { ctx = new C(); master = ctx.createGain(); master.gain.value = muted ? 0 : 1; master.connect(ctx.destination); }
      }
      if (ctx && ctx.state === 'suspended') ctx.resume();
      return ctx;
    }
    function tone(o) {
      var c = ac(); if (!c || muted) return;
      var t = c.currentTime + (o.t || 0), d = o.d || 0.3;
      var osc = c.createOscillator(), g = c.createGain();
      osc.type = o.type || 'sine';
      osc.frequency.setValueAtTime(o.f, t);
      if (o.f2) osc.frequency.exponentialRampToValueAtTime(o.f2, t + d);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(o.g || 0.3, t + 0.012);
      if (o.hold) g.gain.setValueAtTime(o.g || 0.3, t + d - 0.06);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      osc.connect(g); g.connect(master);
      osc.start(t); osc.stop(t + d + 0.05);
    }
    function noise(t, d, g, freq) {
      var c = ac(); if (!c || muted) return;
      var n = Math.floor(c.sampleRate * d), buf = c.createBuffer(1, n, c.sampleRate), data = buf.getChannelData(0);
      for (var i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
      var src = c.createBufferSource(), f = c.createBiquadFilter(), gn = c.createGain();
      src.buffer = buf; f.type = 'bandpass'; f.frequency.value = freq || 2500; f.Q.value = 1.2;
      gn.gain.value = g;
      src.connect(f); f.connect(gn); gn.connect(master);
      src.start(c.currentTime + (t || 0));
    }
    function bell(f, t, g) {
      tone({ f: f, t: t, d: 1.0, g: g }); tone({ f: f * 2, t: t, d: 0.6, g: g * 0.35 }); tone({ f: f * 3.01, t: t, d: 0.3, g: g * 0.15 });
    }
    return {
      unlock: ac,
      ctx: ac,
      mute: function (v) { muted = v; if (master) master.gain.setTargetAtTime(v ? 0 : 1, ctx.currentTime, 0.03); },
      isMuted: function () { return muted; },
      hop: function () { noise(0, 0.03, 0.35, 1800); tone({ f: 700, type: 'triangle', d: 0.04, g: 0.08 }); },   // the token hops a space
      dice: function () { for (var i = 0; i < 6; i++) noise(i * 0.07, 0.04, 0.5, 900 + i * 300); tone({ f: 420, type: 'square', t: 0.42, d: 0.06, g: 0.08 }); },
      cash: function () { tone({ f: 1318, type: 'triangle', d: 0.09, g: 0.16 }); tone({ f: 1760, type: 'triangle', t: 0.07, d: 0.16, g: 0.14 }); bell(2637, 0.14, 0.1); },
      pay: function () { tone({ f: 523, type: 'triangle', d: 0.12, g: 0.14 }); tone({ f: 392, type: 'triangle', t: 0.12, d: 0.26, g: 0.14 }); },
      buy: function () { [523, 659, 784].forEach(function (f, i) { tone({ f: f, type: 'triangle', t: i * 0.08, d: 0.18, g: 0.18 }); }); bell(1568, 0.26, 0.14); },
      build: function () { noise(0, 0.05, 0.6, 1400); tone({ f: 220, type: 'square', t: 0.05, d: 0.08, g: 0.08 }); noise(0.14, 0.05, 0.6, 1600); },
      card: function () { noise(0, 0.12, 0.3, 4000); tone({ f: 880, type: 'sine', t: 0.1, d: 0.3, g: 0.08 }); },
      jail: function () {
        [196, 185, 175, 165].forEach(function (f, i) { tone({ f: f, type: 'sawtooth', t: i * 0.2, d: i === 3 ? 0.9 : 0.22, g: 0.16 }); });
        noise(0.85, 0.08, 0.5, 600);
      },
      free: function () { [392, 523, 659, 784].forEach(function (f, i) { tone({ f: f, type: 'triangle', t: i * 0.08, d: 0.16, g: 0.16 }); }); },
      gavel: function () { noise(0, 0.05, 0.9, 700); tone({ f: 140, type: 'square', d: 0.07, g: 0.14 }); },
      bid: function () { tone({ f: 988, type: 'square', d: 0.05, g: 0.07 }); tone({ f: 1319, type: 'square', t: 0.05, d: 0.08, g: 0.07 }); },
      broke: function () {
        [392, 370, 349, 311].forEach(function (f, i) { tone({ f: f, type: 'sawtooth', t: i * 0.22, d: i === 3 ? 0.8 : 0.24, g: 0.16 }); });
        tone({ f: 120, f2: 50, type: 'triangle', t: 0.66, d: 0.9, g: 0.3 });
      },
      tick: function () { tone({ f: 1000, type: 'square', d: 0.04, g: 0.09 }); },
      join: function () { tone({ f: 660, d: 0.09, g: 0.14 }); tone({ f: 990, t: 0.08, d: 0.2, g: 0.14 }); },
      turn: function () { tone({ f: 880, type: 'sine', d: 0.1, g: 0.1 }); tone({ f: 1108, type: 'sine', t: 0.1, d: 0.22, g: 0.1 }); },
      trade: function () { [659, 784, 659, 784].forEach(function (f, i) { tone({ f: f, type: 'triangle', t: i * 0.09, d: 0.12, g: 0.12 }); }); },
      go: function () { [523, 659, 784, 1047].forEach(function (f, i) { tone({ f: f, type: 'triangle', t: i * 0.07, d: 0.14, g: 0.14 }); }); },
      win: function () {
        [523, 523, 523, 659, 784, 659, 784, 1047].forEach(function (f, i) { tone({ f: f, type: 'triangle', t: i * 0.15, d: i === 7 ? 1.2 : 0.22, g: 0.26 }); });
        [262, 330, 392].forEach(function (f) { tone({ f: f, type: 'sawtooth', t: 1.05, d: 1.2, g: 0.07 }); });
      },
      horn: function () { tone({ f: 330, type: 'sawtooth', d: 0.6, g: 0.18, hold: true }); tone({ f: 415, type: 'sawtooth', d: 0.6, g: 0.14, hold: true }); tone({ f: 494, type: 'sawtooth', t: 0.02, d: 0.58, g: 0.12, hold: true }); },
      whoosh: function () { tone({ f: 220, f2: 880, type: 'sine', d: 0.45, g: 0.08 }); },
      chaching: function () { noise(0, 0.05, 0.5, 5000); bell(2093, 0.05, 0.22); bell(2637, 0.12, 0.2); tone({ f: 1047, type: 'triangle', t: 0.18, d: 0.5, g: 0.12 }); },   // passing GO
      coins: function () { for (var i = 0; i < 5; i++) bell(2500 + Math.random() * 1500, i * 0.06, 0.07); },
      sting: function () { tone({ f: 110, type: 'sawtooth', d: 0.9, g: 0.28, hold: true }); tone({ f: 116, type: 'sawtooth', d: 0.9, g: 0.2, hold: true }); tone({ f: 1760, f2: 220, type: 'square', d: 0.35, g: 0.08 }); },   // a big rent
      hammer: function () { noise(0, 0.04, 0.9, 1200); tone({ f: 180, type: 'square', d: 0.06, g: 0.12 }); noise(0.16, 0.04, 0.9, 1400); tone({ f: 200, type: 'square', t: 0.16, d: 0.06, g: 0.12 }); },
      fanfare: function () {
        [523, 659, 784, 1047, 1319].forEach(function (f, i) { tone({ f: f, type: 'triangle', t: i * 0.09, d: i === 4 ? 1.0 : 0.16, g: 0.24 }); });
        [262, 330, 392, 523].forEach(function (f) { tone({ f: f, type: 'sawtooth', t: 0.36, d: 1.0, g: 0.05 }); });
      },
      doubles: function () { [784, 988, 1175, 1568].forEach(function (f, i) { tone({ f: f, type: 'square', t: i * 0.06, d: 0.12, g: 0.09 }); }); },
      clang: function () { tone({ f: 420, type: 'square', d: 0.9, g: 0.16 }); tone({ f: 633, type: 'square', d: 0.6, g: 0.1 }); noise(0, 0.12, 0.9, 900); tone({ f: 70, type: 'triangle', d: 0.5, g: 0.3 }); },   // the cell door
      crash: function () { noise(0, 0.5, 1.2, 400); noise(0.1, 0.4, 0.8, 250); tone({ f: 80, f2: 30, type: 'triangle', d: 1.2, g: 0.4 }); },
      countdown: function () { tone({ f: 880, type: 'square', d: 0.07, g: 0.1 }); },
      going: function () { noise(0, 0.05, 0.7, 700); tone({ f: 160, type: 'square', d: 0.08, g: 0.12 }); },
      ping: function () { tone({ f: 1760, type: 'sine', d: 0.1, g: 0.14 }); tone({ f: 2349, type: 'sine', t: 0.1, d: 0.25, g: 0.12 }); },
      shake: function () { for (var i = 0; i < 4; i++) noise(i * 0.09, 0.05, 0.4, 1500 + i * 200); }
    };
  })();

  /* ---- the board's geometry ----
     A square of `size` pixels. Corners are `c` wide, the nine spaces between them `w` wide.
     Space 0 (GO) is bottom right; the board runs counter-clockwise from there, the way the real one does. */
  F.cells = function (size) {
    var c = Math.round(size * 0.138), w = (size - 2 * c) / 9, out = [];
    for (var i = 0; i < 40; i++) {
      var r;
      if (i === 0) r = { x: size - c, y: size - c, w: c, h: c, side: 'corner', dir: 'bottom' };
      else if (i < 10) r = { x: size - c - i * w, y: size - c, w: w, h: c, side: 'bottom' };
      else if (i === 10) r = { x: 0, y: size - c, w: c, h: c, side: 'corner', dir: 'left' };
      else if (i < 20) r = { x: 0, y: size - c - (i - 10) * w, w: c, h: w, side: 'left' };
      else if (i === 20) r = { x: 0, y: 0, w: c, h: c, side: 'corner', dir: 'top' };
      else if (i < 30) r = { x: c + (i - 21) * w, y: 0, w: w, h: c, side: 'top' };
      else if (i === 30) r = { x: size - c, y: 0, w: c, h: c, side: 'corner', dir: 'right' };
      else r = { x: size - c, y: c + (i - 31) * w, w: c, h: w, side: 'right' };
      r.i = i; r.cx = r.x + r.w / 2; r.cy = r.y + r.h / 2;
      out.push(r);
    }
    return { cells: out, corner: c, w: w, size: size };
  };

  // The HTML for one space, used by the TV board and the phone's small board.
  F.spaceHtml = function (sp, cell, names, opts) {
    var B = window.Boards, G = B.GROUPS, name = names ? names[sp.i] : sp.name, esc = F.esc;
    var h = '<div class="sp ' + sp.t + ' ' + cell.side + (cell.dir ? ' ' + cell.dir : '') + '" data-i="' + sp.i + '" style="left:' + cell.x + 'px;top:' + cell.y + 'px;width:' + cell.w + 'px;height:' + cell.h + 'px">';
    if (sp.t === 'prop') h += '<i class="band" style="background:' + G[sp.g].color + '"></i>';
    var icon = { go: '→', chest: '▣', chance: '?', tax: '◆', rail: '▬', util: '✦', jail: '▦', parking: 'P', gotojail: '✋' }[sp.t] || '';
    if (sp.t !== 'prop') h += '<i class="ic ' + sp.t + '">' + icon + '</i>';
    h += '<b class="nm' + (String(name).split(' ').some(function (w) { return w.length >= 9; }) ? ' long' : '') + '">' + esc(name) + '</b>';
    if (sp.price) h += '<em class="pr">' + F.money(sp.price) + '</em>';
    else if (sp.t === 'tax') h += '<em class="pr">PAY ' + F.money(sp.amount) + '</em>';
    if (opts && opts.owners) h += '<span class="own" data-live></span>';
    return h + '</div>';
  };

  // A property card's rent table, for the phone.
  F.rentRows = function (sp, rails) {
    var G = window.Boards.GROUPS;
    if (sp.t === 'rail') return [['1 owned', '$25'], ['2 owned', '$50'], ['3 owned', '$100'], ['4 owned', '$200']];
    if (sp.t === 'util') return [['1 owned', '4 × dice'], ['2 owned', '10 × dice']];
    var r = sp.rent;
    return [['Rent', F.money(r[0])], ['With the whole ' + G[sp.g].name.toLowerCase() + ' set', F.money(r[0] * 2)], ['1 house', F.money(r[1])], ['2 houses', F.money(r[2])], ['3 houses', F.money(r[3])], ['4 houses', F.money(r[4])], ['Hotel', F.money(r[5])]];
  };
})();
