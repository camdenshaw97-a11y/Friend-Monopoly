# Friend Monopoly: what changed, and when

Every change to the game gets an entry here, newest first. The version number is the same one
shown in small print on the TV's start screen and on the phone join screen, so you can tell at a
glance which version a screen is running.

Times are Pacific.

## 1.3 · October 25, 2026

**Build a whole set from one tap**
- When you own a whole color group, opening any street in it shows the set: every street with
  its houses, a NEXT tag on the one the next house goes on, and **Build a house** / **Sell a
  house** buttons that always keep the set even. No more opening each street in turn. The
  usual even-building rule still decides where the next house lands (fewest houses first).
- **Fix:** "Nobody yet. Scan the code to join." is centered in the players box.

## 1.2 · October 25, 2026

**Boards that look like where they are, colors, and a few fixes**
- **Themed boards.** Each board has its own look on the TV: San Diego is sand, sea and
  palms with a sunset band; Las Vegas is a dark board with a neon star, dice and card suits;
  Classic stays classic. The room behind the board changes color to match.
- **Pick your color** in the lobby, next to your piece. It's the ring behind your emoji on the
  board and the color of your panel. Remembered for next time, like your piece.
- **JOIN CODE** button in the bottom right of the TV during a game: tap it for a big QR code
  and the room code, for anyone who needs to get back in.
- **Add time** to a timed game from the TV: +5, +10, +15 or +30 minutes in the tools row.
- **Fix:** the Log tab on phones drew a giant ROLL button over the entries (a log line about a
  roll was picking up the roll button's style). Log lines are styled on their own now.
- **Fix:** the "what's happening" bar on the TV sizes itself to the name of the place instead
  of cutting it off; long names on the narrow spaces (Cosmopolitan, Chinatown) fit their cells.
- The TV's tool chips wrap to two rows so they stay under the log.

## 1.1 · October 25, 2026

**Polish, bots, chat, and more going on**
- **Bots.** The TV can add up to 8 bots in the lobby (**+ Add a bot**). They roll, buy what they
  can afford, bid at auctions, build on their sets, pay their debts, answer your trade offers
  sensibly, and go shopping for the last property of a set now and then. Each one plays a
  slightly different game.
- **Chat.** A Chat tab on the phone: private, one-to-one messages between players. Nothing
  shows on the TV.
- **Any emoji as your piece.** The lobby has eight quick picks and a box for any emoji from your
  keyboard. Your pick is remembered for next time.
- **Bidding clock.** Set on the TV (10, 15, 20 or 30 seconds). Every bid restarts it; the TV
  shows the countdown, calls "going once… going twice…", and ticks through the last five seconds.
- **More happening on the TV:** money flies between players when rent and purchases change
  hands, a SOLD stamp lands on a bought space, coins burst at GO, bars slam over the jail, the
  screen shakes on a big rent or a bankruptcy, DOUBLES! and MONOPOLY! banners (with the set
  lighting up and a fanfare when someone completes a color group), little houses with roofs
  instead of squares, and new sounds for all of it.
- **Phone cleanup.** Roomier layout; your properties are one line each, and tapping one opens
  its card with Build / Sell / Mortgage and the reason when something isn't allowed; a cleaner
  trade builder with +50/+100 buttons and a plain-English summary of the offer; incoming offers
  shown side by side.
- **Dialogs in the game's own style** on both screens: no more browser pop-ups for mortgaging,
  bankruptcy, saving, ending a game or leaving.
- **TV fixes:** the lobby no longer overflows its boxes, the log fills its box with no gap, the
  "what's happening" box names the right player, plate badges no longer cover the net worth.

## 1.0 · October 25, 2026

**The first version**
- Fourth game in the collection and the first board game, built the same way as Friend Feud,
  Friend Jeopardy and Friend Wheel: the board on the TV, a 4-letter room code or QR code to
  join, the same reconnecting and "survives a server restart" behavior.
- 2 to 8 players, each on their own phone, each with their own piece. The game is the banker.
  Tap ROLL; the TV walks your piece round the board.
- The official rules: $1,500 to start, $200 for GO, nothing on Free Parking, doubles roll again
  and three in a row go to jail, auctions for declined properties, rent doubled on a whole
  unimproved color group, even building with 32 houses and 12 hotels in the bank, mortgages at
  half with 10% to lift, jail with three rolls / $50 / a card, bankruptcy to a player or to the
  bank (with its properties auctioned).
- Trading any time from your phone: properties, cash and jail cards, with accept, decline and
  counter.
- Chance and Community Chest with the real effects, in two decks: Classic and an 18+ Late Night
  deck.
- Three boards (Classic, San Diego, Las Vegas) and a board editor on the TV for your own.
- Two ways to end, chosen on the TV: a time limit of any length (then ranked by net worth, with
  the bankrupt placed below by who went out last), or last player standing. An optional turn
  clock, and the game plays for a phone that has dropped off.
- Save a game from the TV and pick it up another night; everyone rejoins with the same name.
- Awards on the closing screen: Slumlord, Best Tenant, Jailbird, Big Spender.
- `npm test` plays whole games against the server and checks the rules.
