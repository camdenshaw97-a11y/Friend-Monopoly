/*
 * The board: 40 spaces, the standard prices and rents, and the themes that put names on them.
 * Used by the server (rules) and by both pages (drawing). Works in Node and in the browser.
 *
 * A theme only changes the names on the board (and what the stations, the two utilities and
 * the two taxes are called). Prices, rents and colors are the same on every board, so a game on
 * the San Diego board plays exactly like one on the classic board.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Boards = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The color groups, in board order. `color` is what the TV and phones paint the band with.
  var GROUPS = {
    brown: { name: 'Brown', color: '#8b4a2b', ink: '#fff' },
    lightblue: { name: 'Light Blue', color: '#8fd0f0', ink: '#06283d' },
    pink: { name: 'Pink', color: '#d63d8f', ink: '#fff' },
    orange: { name: 'Orange', color: '#f29a1c', ink: '#2a1800' },
    red: { name: 'Red', color: '#e02b2b', ink: '#fff' },
    yellow: { name: 'Yellow', color: '#f6e03a', ink: '#2a2400' },
    green: { name: 'Green', color: '#1f9b4a', ink: '#fff' },
    darkblue: { name: 'Dark Blue', color: '#1f3fcf', ink: '#fff' },
    rail: { name: 'Stations', color: '#222', ink: '#fff' },
    util: { name: 'Utilities', color: '#8a8f99', ink: '#fff' }
  };

  // Every space, by index, clockwise from GO. Streets: price, the six rents (no houses, 1 to 4
  // houses, a hotel) and what one house costs. Stations $200, utilities $150.
  var P = function (g, price, rent, house) { return { t: 'prop', g: g, price: price, rent: rent, house: house }; };
  var LAYOUT = [
    { t: 'go' },
    P('brown', 60, [2, 10, 30, 90, 160, 250], 50),
    { t: 'chest' },
    P('brown', 60, [4, 20, 60, 180, 320, 450], 50),
    { t: 'tax', amount: 200 },
    { t: 'rail', g: 'rail', price: 200 },
    P('lightblue', 100, [6, 30, 90, 270, 400, 550], 50),
    { t: 'chance' },
    P('lightblue', 100, [6, 30, 90, 270, 400, 550], 50),
    P('lightblue', 120, [8, 40, 100, 300, 450, 600], 50),
    { t: 'jail' },
    P('pink', 140, [10, 50, 150, 450, 625, 750], 100),
    { t: 'util', g: 'util', price: 150 },
    P('pink', 140, [10, 50, 150, 450, 625, 750], 100),
    P('pink', 160, [12, 60, 180, 500, 700, 900], 100),
    { t: 'rail', g: 'rail', price: 200 },
    P('orange', 180, [14, 70, 200, 550, 750, 950], 100),
    { t: 'chest' },
    P('orange', 180, [14, 70, 200, 550, 750, 950], 100),
    P('orange', 200, [16, 80, 220, 600, 800, 1000], 100),
    { t: 'parking' },
    P('red', 220, [18, 90, 250, 700, 875, 1050], 150),
    { t: 'chance' },
    P('red', 220, [18, 90, 250, 700, 875, 1050], 150),
    P('red', 240, [20, 100, 300, 750, 925, 1100], 150),
    { t: 'rail', g: 'rail', price: 200 },
    P('yellow', 260, [22, 110, 330, 800, 975, 1150], 150),
    P('yellow', 260, [22, 110, 330, 800, 975, 1150], 150),
    { t: 'util', g: 'util', price: 150 },
    P('yellow', 280, [24, 120, 360, 850, 1025, 1200], 150),
    { t: 'gotojail' },
    P('green', 300, [26, 130, 390, 900, 1100, 1275], 200),
    P('green', 300, [26, 130, 390, 900, 1100, 1275], 200),
    { t: 'chest' },
    P('green', 320, [28, 150, 450, 1000, 1200, 1400], 200),
    { t: 'rail', g: 'rail', price: 200 },
    { t: 'chance' },
    P('darkblue', 350, [35, 175, 500, 1100, 1300, 1500], 200),
    { t: 'tax', amount: 100 },
    P('darkblue', 400, [50, 200, 600, 1400, 1700, 2000], 200)
  ];

  // The 30 spaces a theme names, in board order: 22 streets, 4 stations, 2 utilities, 2 taxes.
  var NAMED = [];
  LAYOUT.forEach(function (s, i) { if (s.t === 'prop' || s.t === 'rail' || s.t === 'util' || s.t === 'tax') NAMED.push(i); });

  var THEMES = [
    {
      id: 'classic', name: 'Classic', blurb: 'The board everyone knows: Baltic to Boardwalk.',
      rails: 'Railroads',
      names: {
        1: 'Mediterranean Avenue', 3: 'Baltic Avenue', 4: 'Income Tax', 5: 'Reading Railroad',
        6: 'Oriental Avenue', 8: 'Vermont Avenue', 9: 'Connecticut Avenue',
        11: 'St. Charles Place', 12: 'Electric Company', 13: 'States Avenue', 14: 'Virginia Avenue',
        15: 'Pennsylvania Railroad', 16: 'St. James Place', 18: 'Tennessee Avenue', 19: 'New York Avenue',
        21: 'Kentucky Avenue', 23: 'Indiana Avenue', 24: 'Illinois Avenue', 25: 'B. & O. Railroad',
        26: 'Atlantic Avenue', 27: 'Ventnor Avenue', 28: 'Water Works', 29: 'Marvin Gardens',
        31: 'Pacific Avenue', 32: 'North Carolina Avenue', 34: 'Pennsylvania Avenue', 35: 'Short Line',
        37: 'Park Place', 38: 'Luxury Tax', 39: 'Boardwalk'
      }
    },
    {
      id: 'sandiego', name: 'San Diego', blurb: 'Imperial Beach to La Jolla, with the trolley lines as the stations.',
      rails: 'Trolley lines',
      names: {
        1: 'Imperial Beach', 3: 'National City', 4: 'Income Tax', 5: 'Blue Line',
        6: 'Lakeside', 8: 'Santee', 9: 'El Cajon',
        11: 'Clairemont', 12: 'Power Company', 13: 'Mission Valley', 14: 'Hillcrest',
        15: 'Orange Line', 16: 'North Park', 18: 'South Park', 19: 'Ocean Beach',
        21: 'Pacific Beach', 23: 'Mission Beach', 24: 'Gaslamp Quarter', 25: 'Green Line',
        26: 'Little Italy', 27: 'Petco Park', 28: 'Water Works', 29: 'Balboa Park',
        31: 'Point Loma', 32: 'Encinitas', 34: 'Del Mar', 35: 'The Coaster',
        37: 'Coronado', 38: 'Luxury Tax', 39: 'La Jolla'
      }
    },
    {
      id: 'vegas', name: 'Las Vegas', blurb: 'Fremont Street to the Sphere. The Strip, priced like the Strip.',
      rails: 'Getting around',
      names: {
        1: 'Fremont Street', 3: 'Arts District', 4: 'Resort Fee', 5: 'Harry Reid Airport',
        6: 'Chinatown', 8: 'Circus Circus', 9: 'The Strat',
        11: 'Excalibur', 12: 'Power Company', 13: 'Luxor', 14: 'New York-New York',
        15: 'The Monorail', 16: 'The LINQ', 18: 'Flamingo', 19: 'Planet Hollywood',
        21: 'MGM Grand', 23: 'Mandalay Bay', 24: 'Paris Las Vegas', 25: 'The Deuce',
        26: 'Caesars Palace', 27: 'The Venetian', 28: 'Water Works', 29: 'Cosmopolitan',
        31: 'Aria', 32: 'Wynn', 34: 'Encore', 35: 'Vegas Loop',
        37: 'Bellagio', 38: 'Luxury Tax', 39: 'The Sphere'
      }
    }
  ];

  var FIXED = { 0: 'GO', 2: 'Community Chest', 7: 'Chance', 10: 'Jail', 17: 'Community Chest', 20: 'Free Parking', 22: 'Chance', 30: 'Go to Jail', 33: 'Community Chest', 36: 'Chance' };

  function clean(s, max) {
    return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  // A board the TV made up: a name and up to 30 names of its own. Anything missing keeps the classic name.
  function customTheme(c) {
    if (!c || typeof c !== 'object') return null;
    var name = clean(c.name, 24);
    if (!name) return null;
    var names = {}, got = 0;
    NAMED.forEach(function (i) {
      var v = c.names && clean(c.names[i], 24);
      if (v) { names[i] = v; got++; } else names[i] = THEMES[0].names[i];
    });
    if (!got) return null;
    return { id: 'custom:' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name: name, blurb: 'Your own board', rails: clean(c.rails, 20) || 'Stations', names: names, custom: true };
  }

  // The 40 spaces with this theme's names on them.
  function build(theme) {
    theme = theme || THEMES[0];
    return LAYOUT.map(function (s, i) {
      var out = Object.assign({ i: i, name: theme.names[i] || FIXED[i] || '' }, s);
      if (s.t === 'rail') out.gname = theme.rails;
      return out;
    });
  }

  function themeById(id, customs) {
    var all = THEMES.concat(customs || []);
    for (var k = 0; k < all.length; k++) if (all[k].id === id) return all[k];
    return THEMES[0];
  }

  return {
    GROUPS: GROUPS, LAYOUT: LAYOUT, NAMED: NAMED, THEMES: THEMES, FIXED: FIXED,
    build: build, themeById: themeById, customTheme: customTheme,
    groupOf: function (i) { var s = LAYOUT[i]; return s && s.g ? s.g : null; },
    members: function (g) { var out = []; LAYOUT.forEach(function (s, i) { if (s.g === g) out.push(i); }); return out; },
    isOwnable: function (i) { var s = LAYOUT[i]; return !!(s && s.price); }
  };
});
