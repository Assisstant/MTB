// One catalogue, shared with the WBACC ready stamps. The old GLASOVI decks
// and their groups are never changed by this optional section.
window.letterPositions = function (text, letter) {
  const found = new Set();
  for (const token of text.normalize('NFC').toLocaleLowerCase('mk').match(/\p{L}+/gu) || []) {
    const chars = [...token];
    chars.forEach((ch, i) => {
      if (ch !== letter) return;
      if (i === 0) found.add('start');
      if (i === chars.length - 1) found.add('end');
      if (i > 0 && i < chars.length - 1) found.add('middle');
    });
  }
  return [...found];
};
window.VEZBI_LETTERS = window.LETTER_CATALOG.categories.map(category => {
  const words = window.LETTER_CATALOG.items.filter(item =>
    item.category === category.letter || window.letterPositions(item.text, category.letter).length);
  return {
    ...category, kind: 'letters', title: 'Буква ' + category.letter.toUpperCase(), audioFile: 'letters',
    words: words.map(item => ({w: item.text, img: 'letters:' + item.id,
      home: item.category === category.letter, positions: window.letterPositions(item.text, category.letter)})),
    sentences: [],
    img: Object.fromEntries(words.map(item => ['letters:' + item.id, item.image])),
    audioSources: Object.fromEntries(words.map(item => [item.text, {kind: 'marija'}]))
  };
});
