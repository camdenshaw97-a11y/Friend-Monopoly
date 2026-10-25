/* The board editor: name your own board. Lives on the TV page. */
(function () {
  'use strict';
  var F = window.Game, B = window.Boards, $ = F.$, esc = F.esc;
  var KEY = 'mon.boards';

  F.savedBoards = function () {
    var list = F.store.get(KEY, []);
    return Array.isArray(list) ? list.filter(function (b) { return b && typeof b === 'object' && b.name; }).slice(0, 12) : [];
  };

  // Groups of spaces to fill in, in board order.
  function groups() {
    var out = [], byG = {};
    B.NAMED.forEach(function (i) {
      var s = B.LAYOUT[i], g = s.t === 'tax' ? 'tax' : s.g;
      if (!byG[g]) { byG[g] = { g: g, items: [] }; out.push(byG[g]); }
      byG[g].items.push(i);
    });
    return out;
  }

  function groupTitle(g) {
    if (g === 'tax') return 'The two taxes';
    if (g === 'rail') return 'The four stations';
    if (g === 'util') return 'The two utilities';
    return B.GROUPS[g].name + ' (' + B.members(g).length + ')';
  }

  F.openEditor = function (opts) {
    var boards = F.savedBoards(), editing = null;
    var back = document.createElement('div');
    back.className = 'ed-back';
    back.innerHTML = '<div class="ed"></div>';
    document.body.appendChild(back);
    var ed = $('.ed', back);

    function save() { F.store.set(KEY, boards); if (opts.onChange) opts.onChange({ boards: boards }); }
    function close() { back.classList.add('out'); setTimeout(function () { back.remove(); }, 220); }

    function list() {
      var h = '<div class="ed-top"><h2>MY BOARDS</h2><button class="ed-btn ghost" data-a="close">Done</button></div>';
      h += '<p>Name the spaces after your own town, your friends, inside jokes, whatever. Prices and rents stay the same as the classic board, so it plays the same. Pick the board when you set up a game.</p>';
      h += '<div class="ed-row"><button class="ed-btn pri" data-a="new">New board</button><button class="ed-btn" data-a="export">Save to file</button><button class="ed-btn" data-a="import">Load from file</button></div>';
      if (!boards.length) h += '<div class="ed-empty">No boards yet.</div>';
      boards.forEach(function (b, k) {
        var n = Object.keys(b.names || {}).filter(function (i) { return b.names[i]; }).length;
        h += '<div class="ed-q"><b>' + esc(b.name) + '<small>' + n + ' of ' + B.NAMED.length + ' spaces named</small></b><button class="ed-btn" data-a="edit" data-k="' + k + '">Edit</button><button class="ed-btn red" data-a="del" data-k="' + k + '">Delete</button></div>';
      });
      ed.innerHTML = h;
    }

    function form(b) {
      var h = '<div class="ed-top"><h2>' + (b.name ? esc(b.name.toUpperCase()) : 'NEW BOARD') + '</h2><button class="ed-btn ghost" data-a="back">Back</button></div>';
      h += '<p>Cheap at the top, expensive at the bottom, like the real thing. Leave a space blank to keep its classic name.</p>';
      h += '<label>BOARD NAME</label><input id="edName" maxlength="24" value="' + esc(b.name || '') + '" placeholder="e.g. Our Street">';
      h += '<label>WHAT THE STATIONS ARE CALLED</label><input id="edRails" maxlength="20" value="' + esc(b.rails || '') + '" placeholder="e.g. Trolley lines">';
      groups().forEach(function (gr) {
        var col = gr.g === 'tax' ? '#444' : B.GROUPS[gr.g].color;
        h += '<h3><i style="background:' + col + '"></i>' + esc(groupTitle(gr.g)) + '</h3><div class="ed-grid' + (gr.items.length === 2 ? ' two' : '') + '">';
        gr.items.forEach(function (i) {
          var s = B.LAYOUT[i];
          var hint = s.t === 'tax' ? 'pays ' + F.money(s.amount) : F.money(s.price);
          h += '<div><label>' + esc(B.THEMES[0].names[i]) + ' · ' + hint + '</label><input data-i="' + i + '" maxlength="24" value="' + esc((b.names && b.names[i]) || '') + '" placeholder="' + esc(B.THEMES[0].names[i]) + '"></div>';
        });
        h += '</div>';
      });
      h += '<div class="ed-err" id="edErr"></div>';
      h += '<div class="ed-row"><button class="ed-btn pri" data-a="save">Save board</button><button class="ed-btn ghost" data-a="back">Cancel</button></div>';
      ed.innerHTML = h;
      setTimeout(function () { $('#edName', ed).focus(); }, 50);
    }

    function read() {
      var b = { name: $('#edName', ed).value.trim(), rails: $('#edRails', ed).value.trim(), names: {} };
      ed.querySelectorAll('input[data-i]').forEach(function (inp) { var v = inp.value.trim(); if (v) b.names[inp.getAttribute('data-i')] = v; });
      return b;
    }

    back.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-a]'); if (!b) return;
      var a = b.getAttribute('data-a'), k = Number(b.getAttribute('data-k'));
      if (a === 'close') { close(); return; }
      if (a === 'new') { editing = null; form({}); return; }
      if (a === 'edit') { editing = k; form(boards[k]); return; }
      if (a === 'del') { if (confirm('Delete "' + boards[k].name + '"?')) { boards.splice(k, 1); save(); list(); } return; }
      if (a === 'back') { list(); return; }
      if (a === 'save') {
        var nb = read();
        if (!nb.name) { $('#edErr', ed).textContent = 'Give the board a name.'; return; }
        if (!Object.keys(nb.names).length) { $('#edErr', ed).textContent = 'Name at least one space.'; return; }
        if (boards.some(function (x, i) { return i !== editing && x.name.toLowerCase() === nb.name.toLowerCase(); })) { $('#edErr', ed).textContent = 'You already have a board called that.'; return; }
        if (editing == null) boards.push(nb); else boards[editing] = nb;
        save(); list(); return;
      }
      if (a === 'export') {
        var blob = new Blob([JSON.stringify({ boards: boards }, null, 2)], { type: 'application/json' });
        var aEl = document.createElement('a'); aEl.href = URL.createObjectURL(blob); aEl.download = 'my-boards.json'; aEl.click();
        setTimeout(function () { URL.revokeObjectURL(aEl.href); }, 1000);
        return;
      }
      if (a === 'import') {
        var inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/json,.json';
        inp.onchange = function () {
          var f = inp.files[0]; if (!f) return;
          var r = new FileReader();
          r.onload = function () {
            try {
              var d = JSON.parse(r.result), got = 0;
              (d.boards || []).forEach(function (x) { if (x && x.name && x.names && !boards.some(function (y) { return y.name.toLowerCase() === String(x.name).toLowerCase(); })) { boards.push({ name: String(x.name).slice(0, 24), rails: String(x.rails || '').slice(0, 20), names: x.names }); got++; } });
              save(); list();
              alert(got ? 'Loaded ' + F.plural(got, 'board') + '.' : 'Nothing new in that file.');
            } catch (e) { alert("That file isn't a boards file."); }
          };
          r.readAsText(f);
        };
        inp.click();
      }
    });
    list();
  };
})();
