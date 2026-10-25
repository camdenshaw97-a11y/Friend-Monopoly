'use strict';
/*
 * Chance and Community Chest. Two decks with the same 32 effects: the Classic deck says it the
 * way the rulebook does, the Late Night deck says it the way your friends would at 1 a.m.
 *
 * {s24} in a card's text is the name of space 24 on whatever board is being played, so the cards
 * read right on every theme.
 */

const CLASSIC = {
  chance: [
    { k: 'move', to: 0, text: 'Advance to GO. Collect $200.' },
    { k: 'move', to: 24, text: 'Advance to {s24}. If you pass GO, collect $200.' },
    { k: 'move', to: 11, text: 'Advance to {s11}. If you pass GO, collect $200.' },
    { k: 'nearest', kind: 'util', text: 'Advance to the nearest utility. If unowned, you may buy it from the bank. If owned, throw the dice and pay the owner ten times the amount thrown.' },
    { k: 'nearest', kind: 'rail', text: 'Advance to the nearest station. If unowned, you may buy it from the bank. If owned, pay the owner twice the rent they are otherwise entitled to.' },
    { k: 'nearest', kind: 'rail', text: 'Advance to the nearest station. If unowned, you may buy it from the bank. If owned, pay the owner twice the rent they are otherwise entitled to.' },
    { k: 'collect', n: 50, text: 'Bank pays you a dividend of $50.' },
    { k: 'jailfree', text: 'Get out of jail free. Keep this card until needed, or trade it.' },
    { k: 'back', n: 3, text: 'Go back three spaces.' },
    { k: 'jail', text: 'Go directly to jail. Do not pass GO. Do not collect $200.' },
    { k: 'repairs', house: 25, hotel: 100, text: 'Make general repairs on all your property: $25 for each house, $100 for each hotel.' },
    { k: 'pay', n: 15, text: 'Speeding fine: $15.' },
    { k: 'move', to: 5, text: 'Take a trip to {s5}. If you pass GO, collect $200.' },
    { k: 'move', to: 39, text: 'Take a walk to {s39}. Advance to {s39}.' },
    { k: 'payEach', n: 50, text: 'You have been elected chairman of the board. Pay each player $50.' },
    { k: 'collect', n: 150, text: 'Your building loan matures. Collect $150.' }
  ],
  chest: [
    { k: 'move', to: 0, text: 'Advance to GO. Collect $200.' },
    { k: 'collect', n: 200, text: 'Bank error in your favor. Collect $200.' },
    { k: 'pay', n: 50, text: "Doctor's fee. Pay $50." },
    { k: 'collect', n: 50, text: 'From sale of stock you get $50.' },
    { k: 'jailfree', text: 'Get out of jail free. Keep this card until needed, or trade it.' },
    { k: 'jail', text: 'Go directly to jail. Do not pass GO. Do not collect $200.' },
    { k: 'collect', n: 100, text: 'Holiday fund matures. Receive $100.' },
    { k: 'collect', n: 20, text: 'Income tax refund. Collect $20.' },
    { k: 'each', n: 10, text: 'It is your birthday. Collect $10 from every player.' },
    { k: 'collect', n: 100, text: 'Life insurance matures. Collect $100.' },
    { k: 'pay', n: 100, text: 'Pay hospital fees of $100.' },
    { k: 'pay', n: 50, text: 'Pay school fees of $50.' },
    { k: 'collect', n: 25, text: 'Receive $25 consultancy fee.' },
    { k: 'repairs', house: 40, hotel: 115, text: 'You are assessed for street repairs: $40 per house, $115 per hotel.' },
    { k: 'collect', n: 10, text: 'You have won second prize in a beauty contest. Collect $10.' },
    { k: 'collect', n: 100, text: 'You inherit $100.' }
  ]
};

// Same effects, different night. Innuendo, not anatomy.
const LATE_NIGHT = {
  chance: [
    { k: 'move', to: 0, text: 'Your situationship texts "u up?" Sprint to GO and collect $200.' },
    { k: 'move', to: 24, text: 'You heard {s24} is where the hot people go tonight. Advance there. If you pass GO, collect $200.' },
    { k: 'move', to: 11, text: 'Your ex is at {s11} and you want them to see you winning. Advance there. If you pass GO, collect $200.' },
    { k: 'nearest', kind: 'util', text: 'Your power got cut off mid-shower. Advance to the nearest utility. If unowned, buy it. If owned, throw the dice and pay ten times the roll.' },
    { k: 'nearest', kind: 'rail', text: 'Too many drinks to drive. Advance to the nearest station. If unowned, buy it. If owned, pay the owner double rent for the ride.' },
    { k: 'nearest', kind: 'rail', text: 'You wake up on public transit with no memory of boarding. Advance to the nearest station. If unowned, buy it. If owned, pay double rent.' },
    { k: 'collect', n: 50, text: 'Your OnlyFans finally pays out. Collect $50.' },
    { k: 'jailfree', text: 'Get out of jail free. Somebody owes you a favor and you know exactly what for. Keep this card or trade it.' },
    { k: 'back', n: 3, text: 'Walk of shame. Go back three spaces.' },
    { k: 'jail', text: 'Caught in the club bathroom with the door locked. Go directly to jail. Do not pass GO. Do not collect $200.' },
    { k: 'repairs', house: 25, hotel: 100, text: 'The afterparty got out of hand. Repairs: $25 per house, $100 per hotel.' },
    { k: 'pay', n: 15, text: 'You bought a round to impress someone and they left with your friend. Pay $15.' },
    { k: 'move', to: 5, text: 'Strangers on the night train, and one of them is cute. Take a trip to {s5}. If you pass GO, collect $200.' },
    { k: 'move', to: 39, text: 'A sugar mama wants to see you at {s39}. Advance there and act natural.' },
    { k: 'payEach', n: 50, text: 'You said "drinks are on me" loud enough for the whole bar to hear. Pay each player $50.' },
    { k: 'collect', n: 150, text: 'Your best friend finally pays back the money from Vegas. Collect $150.' }
  ],
  chest: [
    { k: 'move', to: 0, text: 'Somebody hot said you look like a winner. Advance to GO and collect $200.' },
    { k: 'collect', n: 200, text: 'Your Venmo request to the group chat actually got paid. Collect $200.' },
    { k: 'pay', n: 50, text: 'The clinic visit after spring break. Pay $50. No questions.' },
    { k: 'collect', n: 50, text: 'You sold your ex\'s hoodie on Depop. Collect $50.' },
    { k: 'jailfree', text: 'Get out of jail free. The bouncer thinks you\'re cute. Keep this card or trade it.' },
    { k: 'jail', text: 'Skinny dipping in the HOA pool. Go directly to jail. Do not pass GO. Do not collect $200.' },
    { k: 'collect', n: 100, text: 'Your bachelor party fund came back with money left over. Somehow. Collect $100.' },
    { k: 'collect', n: 20, text: 'You found a $20 in the jeans you wore to the thing you don\'t talk about. Collect $20.' },
    { k: 'each', n: 10, text: 'It\'s your birthday and everyone has to kiss you. Or pay $10. Collect $10 from every player.' },
    { k: 'collect', n: 100, text: 'A rich stranger slid into your DMs and it was legit. Collect $100.' },
    { k: 'pay', n: 100, text: 'The hot tub broke during "a gathering". Pay $100.' },
    { k: 'pay', n: 50, text: 'You lost a bet about who could last the longest. Pay $50.' },
    { k: 'collect', n: 25, text: 'Someone paid you $25 for "advice". Collect $25.' },
    { k: 'repairs', house: 40, hotel: 115, text: 'The neighbors complained about the noise. Again. Pay $40 per house and $115 per hotel.' },
    { k: 'collect', n: 10, text: 'Second place in a wet T-shirt contest you don\'t remember entering. Collect $10.' },
    { k: 'collect', n: 100, text: 'A distant relative left you $100 and a very confusing letter. Collect $100.' }
  ]
};

const DECKS = [
  { id: 'classic', name: 'Classic', blurb: 'The cards the way the rulebook says them.', cards: CLASSIC },
  { id: 'latenight', name: 'Late Night', blurb: 'Same effects, worse decisions. Grown-ups only.', adult: true, cards: LATE_NIGHT }
];

const deckById = id => DECKS.find(d => d.id === id) || DECKS[0];

module.exports = { DECKS, deckById };
