# Friend Monopoly

A property-trading board game played from your phones, built the same way as Friend Feud, Friend
Jeopardy and Friend Wheel. The board goes on the TV; every player's phone rolls, buys, builds,
mortgages and trades. The game is the banker, so nobody counts money and nobody argues about the
rules: it follows the official ones.

## Playing

1. On the computer plugged into the TV, open `YOUR-SITE/tv` and click **Start a new game**.
   Press `F` for full screen.
2. Everyone else opens `YOUR-SITE` on their phone (or scans the QR code on the TV) and types the
   4-letter room code and their name. 2 to 8 players. Each phone picks a piece (one of the quick
   picks, or any emoji from the keyboard) and a color.
3. Short a few people? **+ Add a bot** on the TV. Bots roll, buy, bid, build, trade and pay up
   like anyone else.
4. On the TV, pick the board, the cards, how the game ends, the bidding clock and (if you want
   one) a turn clock. Press **Start the game** on the TV, or the first player to join can start
   it from their phone.
4. Everyone rolls for first. Then it's **ROLL** on your phone when it's your turn; the TV walks your
   piece round the board and tells everyone what happened.

Once a game has started nobody new can join. If your phone dies, reopen the page and join with
the same name: you get your seat and your money back.

To quit for good mid-game, tap **Leave the game** at the bottom of your phone. It counts as
going bankrupt: your properties go up for auction (or to whoever you owe right then) and
everyone else plays on.

## Rules it follows

The rulebook, not the house rules.

- **$1,500 each** to start. $200 for passing or landing on GO. Nothing for Free Parking.
- **Doubles** roll again; three doubles in a row go to jail.
- **Land on something nobody owns:** buy it at the printed price, or decline and it goes to
  **auction**: everyone (including you) can bid from their phone, bids need to beat the last one,
  and the hammer falls when nobody tops it for 8 seconds. No bids and it stays with the bank.
- **Rent** is as printed: doubled on an unimproved street when one player owns the whole color
  group; stations pay $25, $50, $100, $200 by how many the owner has; utilities pay 4× the dice
  (10× with both). A mortgaged property collects nothing. You collect rent while you're in jail.
- **Chance and Community Chest:** the same 32 effects as the real cards, including Get Out of
  Jail Free, which you keep (or trade) until you use it.
- **Jail:** roll doubles (three tries), pay $50, or use a card. On the third failed roll you pay
  and move anyway.
- **Building:** only with the whole color group, none of it mortgaged, evenly across the group,
  $50 to $200 a house as printed, four houses before a hotel. The bank has 32 houses and 12
  hotels. Sell buildings back for half, evenly. On the phone, open any street of a set you own
  and build or sell across the whole set from there; the game picks the street that keeps it
  even.
- **Mortgages** pay half the price; lifting one costs that plus 10%. Buildings in the group have
  to be sold first.
- **Trading** any time, with anyone: properties (buildings in the group sold first), cash and
  jail cards, in any combination. The other player accepts, declines or counters from their
  phone. Whoever receives a mortgaged property pays the 10% interest on the spot.
- **Debts:** if you can't pay, the game waits while you sell buildings, mortgage, or trade your
  way to the money. Bankruptcy is only on offer when even selling everything wouldn't cover it.
  Bankrupt to a player: they get everything. Bankrupt to the bank: your properties go up for
  auction one by one.

## How the game ends (picked on the TV)

- **When the clock runs out.** Any number of minutes. When time is up, everyone still in is
  ranked by net worth (cash, properties at the printed price or half if mortgaged, buildings at
  cost). Anyone who went bankrupt is placed below them, last out highest.
- **Last player standing.** The game goes until one player is left.

The TV can add time to a timed game (+5 to +30 minutes) or end a game early (**End game**):
richest wins. **JOIN CODE** in the corner shows the QR code and room code big, for anyone who
needs to get back in.

## Boards and cards

- **Boards:** Classic, San Diego, Las Vegas, each with its own look on the TV. Prices, rents and
  color groups are the same on every board; only the names and the scenery change. **My boards…** on the TV lets you name your own board (your town, your
  friends, inside jokes), saved on that computer. Save to file / Load from file moves them
  between computers.
- **Cards:** Classic, or the 18+ **Late Night** deck: the same effects, told differently.
- **Bidding clock:** 10, 15, 20 or 30 seconds. Every bid restarts it; the hammer falls when it
  runs out.
- **Turn clock:** off, or 30, 60 or 90 seconds to roll, buy or settle a debt (twice that for a
  debt) before the game does it for you: it rolls, sends the property to auction, or sells and
  mortgages what it has to. A phone that has dropped off the network gets the same treatment
  after 25 seconds, so one dead battery doesn't stall the table.
- **Chat:** the Chat tab on the phone sends private messages to one other player. The TV never
  shows them.

## Saving a game for another night

A full game can run a couple of hours. In the corner of the TV, **Save game** stores a sealed
copy of the whole game on that computer; it shows up under **Pick up a saved game** on the
start screen. The last game in progress is kept there automatically too. Open one, and everyone
joins again with the same name they had. The clock picks up where it stopped.

A saved game is sealed with a key only your server has, so it only opens on the same site.

## If the server restarts mid-game

Nothing is lost. The TV keeps a sealed copy of the game and hands it back when the server
returns; every screen says "Reconnecting…" for a moment (about a minute on a free host) and then
carries on. Keep the TV page open: the copy lives in that browser.

## Running it

Needs Node.js 18 or newer.

    npm install
    npm start

Then open http://localhost:3000/tv. To play over home Wi-Fi without hosting, phones can join at
`http://YOUR-COMPUTER-IP:3000`.

`npm test` plays whole games against the server with scripted phones and checks the rules:
rent, building, mortgages, trading, auctions, jail, cards, bankruptcy, both ways a game can end,
saving and loading, and surviving a restart.

## Hosting it for free (Render)

1. Put these files in a GitHub repository (everything except `node_modules`).
2. At render.com choose **New > Web Service**, connect the repository, and pick the **Free**
   instance type. Build command `npm install`, start command `node server.js`.
3. Render gives you an address like `friend-monopoly.onrender.com`. That's `YOUR-SITE`.

A free Render service goes to sleep after 15 minutes with nobody on it and takes about a minute
to wake up, so open the TV page a few minutes before the party. The sealed copies the TV keeps
are locked with a key only your server has; on Render the key comes from the service's own id,
so there is nothing to set up. To use a key of your own instead, add an environment variable
named `BACKUP_KEY` with any long random text. (Change it and old saved games won't open.)

## Changing things

- Game name: `F.TITLE` at the top of `common.js`.
- Boards: `boards.js` (prices and rents in `LAYOUT`, the names in `THEMES`).
- Cards: `cards.js`.
- Money, jail, auction timing, how long the token takes to hop, the idle rule: the "rules" block
  at the top of `server.js`.
- Pieces: `PIECES` in `server.js`.

All the sounds are synthesized in the browser, so there are no audio files.

## What changed, and when

See [CHANGELOG.md](CHANGELOG.md). The version number on the TV start screen and the phone join
screen matches the entries there.
