# Вежби за изговор (`vezbi/`) — articulation exercises

This file is the memory of the exercise page. It started as a repository of
its own (`Assisstant/Artikulacija`, 8 Oct 2026) and moved here the same day,
with its history, as the folder `vezbi/` (see „Moved into MTB"). Read
`CLAUDE.md` for the rules of the repository; this file is what the page is,
what was decided about it and what the owner asked for next.

## What this is

The owner is a speech therapist at a school in Битола. About twenty years ago
they made a set of PowerPoint decks, one per speech sound, to practise
articulation with children. This page replaces those decks with one offline
web page that does the same exercise better. It lives in MTB's repository as
one folder and shares **no code and no data** with the records side: no
database, no sign-in, nothing about a pupil.

## The concept, which stays

One deck practises one sound (the first was П). It has two parts:

1. **Syllables.** The sound with each vowel, at the start, in the middle and
   at the end: па – апа – ап, пу – упу – уп, пе – епе – еп, пи – ипи – ип,
   по – опо – оп. The target letter is red.
2. **Words with pictures, with a cue that fades.** Each word is shown three
   times: the whole word, then with the target letter missing, then as blanks
   only. The old decks did this as three slides per group of words.

The words of the П deck, in the owner's three groups of rising difficulty:

| Group | Words |
| --- | --- |
| 1 | па-па |
| 2 | пи-пи, поп, пау |
| 3 | пее, опа, пие |

## Where it stands

The page is `vezbi/index.html` (until 8 Oct 2026 it was the single file
`glas-P.html`, whose concept the owner liked) plus one data file per sound in
`vezbi/glasovi/` and three tile pictures beside it. It frames
`ComuniBoard.html` and `WBACC.html` from the folder above (see „The three
parts"). It still opens by double-click
and works offline, pictures embedded as data URIs. All 26 sounds are in
(288 words, 312 sentences). П and Б have pictures chosen by hand. The other
24 were filled by a script on 8 Oct 2026 with the first ARASAAC match for the
word (300 px; a sentence shows the picture of its hidden word), so that the
owner has something to change: expect wrong ones. People's names (Ана,
Ленче, Филип…) and „ѓезве" have no pictogram and keep the place-holder. The
owner asked for the place-holders to be filled „so мапираните слики"; this
was read as pictograms, not the old decks' own pictures, which stay out of
the repository (see Pictures). It has:

- „Слогови": the syllable table as text; tapping a syllable marks it done.
- „Зборови": all words or one of the three groups.
- „Помош": Цел збор → Без П → Само цртички → Само слика. Every letter is a
  box, so the number of missing sounds is visible; target boxes keep a red edge.
- Tapping one picture moves only that word to its next step.
- „Сите заедно" / „Една по една" (arrows, also on the keyboard).
- „Измешај" and „Работен лист" (print, A4, with name and date lines).

- **Dragging the letter** (built 8 Oct 2026, not yet judged by the owner): in
  „Без П" each card has three tiles, П and two wrong letters from
  `DISTRACTORS`. The right one snaps into the nearest empty box, a wrong one
  goes back and shakes; a tap or Enter places it without dragging. When the
  word is whole it is said aloud.
- **Building the word** (8 Oct 2026, the owner said „направи", not yet
  judged): in „Само цртички" every box of a word takes a letter. Two levels:
  tiles under the card (the word's own letters, shuffled, and two wrong ones;
  a placed tile is gone), or „⌨ Тастатура" in the header — one keyboard for
  the whole screen, fixed at the bottom, in ComuniBoard's Macedonian layout.
  With the keyboard on it also replaces the three tiles of „Без П", and the
  real keyboard types into the same box. A letter is dragged into any box, or
  tapped: a tap goes to the box with the blue ring (a box chosen by a tap,
  else the first empty one). After two wrong tries a box shows its letter
  faintly. A whole word is said aloud and gets a ⭐ (also in „Без П"). A tap
  on an empty box no longer moves the card to its next step; a tap on the
  picture does. Sentences do not have this yet („Без збор" is still a line).
  (Since the evening of 8 Oct the keyboard's button is in the one-row bar and
  a key is the size of a letter box: see „One row of controls".)
- **Voice** (same date): 🔊 on every card. It plays the therapist's recording
  if there is one, else a system voice (Macedonian, else sr/bg/hr/sl/ru).
  „✏️ Уреди" in the header shows the record and delete buttons; a recording
  is at most 5 seconds and is kept in IndexedDB (`artikulacija` / `voice`,
  keyed by the text).
- **Changing a picture** (8 Oct 2026, the owner's idea: place-holder first,
  pictures later, a better editor some day): in „✏️ Уреди" every card has
  „🖼 Слика". It searches ARASAAC (Macedonian, then English; needs the
  internet) and keeps the chosen pictogram as a data URI in IndexedDB store
  `pics`, keyed by the text. „⬇ Извези" downloads the sound's file with those
  pictures inside; the owner puts it in `glasovi/` (or sends it) and then it
  holds on every device.
- The picture is now a `<button class="pic">` inside the card; tapping it, not
  the whole card, moves the word to its next step.

- **Copying a card** (8 Oct 2026): in „✏️ Уреди" every card has „📋 Копирај".
  It draws the card in the step it is in (pictures and letter boxes, no
  tiles or buttons) on a canvas and puts the PNG on the clipboard; where the
  browser refuses, it saves `karticka.png` instead.
- **Sounds**: the letter buttons in the header pick the sound.
- **„Реченици"** (built 8 Oct 2026 with Б, not yet judged): cards with one or
  more pictures and a sentence. Steps: Цела реченица → Без Б (letters, with
  dragging) → Без збор (the word in braces becomes a line) → Само слика.

## One row of controls, and the card in the window (8 Oct 2026, evening)

The owner, at home, after trying the keyboard: „направи all three and make a
polished solution; I would like more real estate for lower resolutions …
Excalidraw is the better concept, with concealed menus". Not yet judged.

- **The bar is one row** (`#bar`), where it was three. Left to right: the
  sound (a menu of 26 letters), the exercise („Слогови", the groups,
  „Реченици"), the cue steps, then „Сите заедно" / „Една по една",
  „⌨ Тастатура" and „⋯". `fitBar()` keeps in the row what the row holds and
  folds the rest, in this order: the groups into a menu, the words of the
  buttons (icons stay), the steps into a menu; a phone gets a second row. A
  folded menu's button says the choice made in it. The same `<button>`s serve
  both ways (`.menu.inline`), so there is one set of handlers.
- **„⋯"** holds what is not pressed during a lesson: „Измешај", „Цел екран",
  „Упатство", „Работен лист", „Уреди", „Извези". It is lit while „Уреди" is on.
- **„Една по една" takes the window** (`body.fit`): the picture gets what the
  bar, the boxes and the keyboard leave, so picture, boxes and 🔊 are whole on
  a laptop (1366×650 inside the browser) and nothing scrolls. 🔊 sits in the
  card's corner unless „Уреди" is on.
- **One size, `--u`**, for the letter box, the tile and the key, taken from the
  window's height. A key is the size of a box except where twelve of them do
  not fit the width (a phone): there the keys are narrower than the boxes.
- **With the keyboard on, a tap on a picture in „Сите заедно" opens that card
  big** (`zoom`), a step in the browser's history: Back, „← Сите заедно" and
  the „Сите заедно" button are the same step back. Without the keyboard a tap
  is still the card's next step.
- **„Цел екран"** (`cardsOnly`) hides the strip of parts and the bar; ✕ in the
  corner or Esc brings them back. The browser's own full screen is asked for
  and not needed.
- **„Упатство"** is the line of instructions; it starts off on a low or narrow
  screen. The strip of parts is 36 px, where it was 50.
- `test:vezbi` holds the low screen: one row, the card whole above the
  keyboard, a key the size of a box, Back.

## ComuniBoard: one row of tools (8 Oct 2026, evening)

The owner asked for the same idea in ComuniBoard („a nice to have overhaul of
ComuniBoard's menus … something really smart"), was shown the plan, and said
„finish all you think you can improve and then we push everything". Not yet
judged. Until then its toolbar carried the comment „All tools visible - no
hidden tabs"; that decision is replaced by this one.

Measured before: standalone on a laptop 153 px of rows before the board, on a
phone 310 px, inside the exercise page 190 px. Now 91 px standalone (a phone
too) and 83 px inside the exercise page. Every control kept its `id` and its
handler; only its place changed.

- **The row** (`.toolbar-scroll`): undo, redo, „Пишување", the text box, paint,
  line, arrow, the colour, the keyboard, paste, 🔊. It never wraps; too narrow,
  it scrolls sideways. The tools sit in the MIDDLE of the row: MTB's floating
  home dock (`home-button.js`) starts in the top left corner, where it used to
  lie over the title and would now lie over the first tools.
- **The selected thing's tools float over the board** (`#contextBar`): the
  colours, delete, align, card, layers, opacity and the size of letters while
  something is selected; the text box's fill, colours, frame and font size
  while a text box is active (`syncContextBar`). The board does not jump when
  they come. A tap in the bar does not un-choose the text box.
- **„⋯"** (`#tbMorePanel`), with words beside the icons: save, the board as a
  picture, backup copy out and in, load a document, the document window, snap,
  the space between letters, the size of the tools, the language, „Цел екран
  (само табла)", „Исчисти ја таблата". An action closes it; a switch or a
  slider leaves it open (`data-stay`).
- **„Само табла"**: the board's row goes, and the pages around it are told
  (`mtb-chrome`), so ComuniBoard's own row and the exercise page's strip go as
  well; ✕ in the corner brings all of them back.
- **ComuniBoard's own row** („WBACC Studio", „Картички", „Кирилична Табла") is
  44 px where it was 66. **Inside the exercise page it is gone**: the page says
  `mtb-host` when the frame has loaded, ComuniBoard hides its row and answers
  with its tabs (`mtb-tabs`), and they are drawn in the strip beside
  „ComuniBoard"; a tap there sends `mtb-tab` back. Only tabs and a switch of
  tab cross between the pages, by `postMessage`, from the same address only
  (from the disk: the `"null"` origin, as for the card).
- **A fault found on the way and fixed:** a text box made by a tap on the
  board was un-chosen by that same tap (a second listener on the board), so
  its controls did nothing until the box was tapped again.
- A NEW control goes into one of the three places by what it is: used while
  working → the row; belongs to the selected thing → `#contextBar`; a file or
  a setting → „⋯" (with a `data-i18n` label in both dictionaries).
- `test:vezbi` holds it: the tabs in the strip and no row of its own, one row
  of tools, no floating bar with nothing selected and one with the pasted
  card, „⋯", „само табла" and the way back.

**Tile pictures are taken from the disk, never through the local server.**
Through the server every page carries „изработил …" with a real name, and
`check:names` reads text, not pictures. `vezbi/tabla.jpg` was retaken that
way (the address `file://…/ComuniBoard.html`, the home dock hidden).

## How a sound is stored

A sound is one file, `vezbi/glasovi/<latin>.js`, that pushes
`{ letter, file, words: [{ w, img, set }], sentences: [{ s, img: [...] }], img: {} }`
to `GLASOVI`, one `<script>` tag in `index.html`, **and one name in the
server's list** (`server/src/lib/public-static.ts`): the server publishes this
folder file by file, so a sound missing from the list is a blank page on the
server and in the cloud while GitHub Pages still shows it.
`public-static.test.ts` fails until the three agree. `img` on a word or
sentence is optional: without it the key into the pictures is the text itself.
`set` is the owner's group (one old slide); the group buttons are made from
it. In `s` the word in `{braces}` is the one hidden in „Без збор". The syllables are generated from
the letter (а у е и о: start, middle, end). Only the voice recordings are
stored between visits.

## The old decks

25 decks, one per sound (Љ and Х share one), about 600 slides and 420
different sentences. The owner's Dropbox list is in the conversation of
8 Oct 2026; the Л link there was a copy of М, and the real Л deck is
`Downloads\Реченици Л.pptx` on this machine. Decks are downloaded to a
temporary folder, never into the repository. Every deck is built the same way:

1. the syllable table (a picture);
2. sentences, four to a slide, each with a picture, then the same slide
   without the text;
3. words, three to a slide, picture and word with the target letter red, then
   pictures only, then (some decks, on a red slide) the word without the
   target letter;
4. the sentences again with one word replaced by a line.

All are converted (8 Oct 2026). The sentences were typed text and came out
with a script; the words were mostly pictures of text and were read from the
slides by eye, so a misread word is possible and the owner should glance over
each sound. Latin look-alikes inside Cyrillic words (y, e, o) were
normalised. The hidden word of a sentence is the one the deck itself blanks
on its last slides; where the deck has no such slide it is the last word with
the target letter. ARASAAC ids for Б: баба 23710, буба 2924, бебе 2275,
бои 2348.

Not done yet from the owner's list: the own photo, building the hidden word
in a sentence, and groups for the sentences (Р has 22 in one list).

## The three parts (built 8 Oct 2026, the owner said „for both"; not yet judged)

`index.html` has a dark strip of tabs on top: 🏠, „Вежби", „ComuniBoard",
„WBACC Studio".

- **🏠 is the start**: a board of three tiles in the style of MTB's Контролна
  табла (thumbnail, coloured chip, title, what it is, when to use it). The
  list is `APPS` in `index.html`. The address picks the part:
  `index.html#vezbi`, `#tabla`, `#crtanje`; no hash is the tiles. The
  browser's Back works.
- **The other two apps open in frames**, loaded the first time they are
  opened, from `../ComuniBoard.html` and `../WBACC.html`: MTB's own files, one
  copy of each. (In the old repository they were copies in a folder `alati/`.)
- **„➜ Во таблата"** (in „✏️ Уреди", beside „📋 Копирај") draws the card as it
  is and posts it to the ComuniBoard frame, which puts it on „Кирилична
  Табла". For WBACC the way is „📋 Копирај" and Ctrl+V.
- **The receiver is in `ComuniBoard.html`**: its outer script takes
  `insert-generated-image` from the page it is opened inside, and from there
  only a picture (`data:image/…`), only from a page of the same address. A
  page opened from the disk says its origin two ways — the message carries
  `"null"`, `location.origin` reads `"file://"` — so that case is named; a
  plain `event.origin === location.origin` refuses every card on a double-click.
- **Inside the frame ComuniBoard does not load MTB's floating home dock**
  (`home-button.js`): the strip above it is the way home, and the dock's own
  home link would open EduHub inside the frame. Opened by itself it still does.
- `vezbi.jpg`, `tabla.jpg`, `crtanje.jpg` beside `index.html` are the tiles'
  thumbnails, screenshots at 640×400 from a clean browser profile (nothing
  personal). The Контролна табла's „Вежби" tab shows the same three.

## Moved into MTB (8 Oct 2026, the owner: „we do this")

The owner asked whether these projects belong in one repository, then: „this
gets published on Render also and locally also, make the plan and we do it
all". Done in a session opened in the MTB folder:

1. **Moved.** The old repository's history came in with `git subtree add
   --prefix=vezbi` (its eight commits are in `git log -- vezbi`). The copies
   in `alati/` were dropped and the receiver went into MTB's `ComuniBoard.html`.
2. **Served.** `server/src/lib/public-static.ts` names the page, its three
   pictures and its 26 sounds one by one, and `/vezbi/` as the one folder
   address that answers. So the local server and the cloud (Render) serve it
   exactly as they serve `ComuniBoard.html` and `WBACC.html`: in the cloud
   behind the owner's Google sign-in like every page but Колега, with no
   sign-in of its own. GitHub Pages serves the folder as it is
   (`…/MTB/vezbi/`), without any sign-in.
3. **Listed.** „Вежби за изговор" in `start.html` (tools), as a card in
   EduHub (`index.html`), and in `app-names.test.ts`. It is not in the
   `app-navigation.js` bar: that bar is the record screens, and ComuniBoard
   and WBACC Studio are not in it either.
4. **Контролна табла in three tabs** (the owner: „Administracija, Evidencija,
   Vezbi, thumbnails"): `scripts\mtb-actions.ps1` (`Get-MtbTabs`, `Tab`,
   `Page`, `File`, `Thumb`) and `scripts\mtb-launcher.ps1`. Администрација is
   the twelve actions that run a script. Евиденција opens the work space's six
   record screens in the cloud (the owner named four; six fill two rows, and a
   row of one is what they turned down on 3 Oct). Вежби opens the three pages
   **from this computer** (`file://`), so a lesson does not wait for the
   Internet or for the cloud to wake.
5. **Not done: closing the old repository** — a README there that points
   here, then archiving it on GitHub. Only after the owner has used the moved
   page; until then its folder on the PC is left as it was.

`scripts\vezbi-zip.ps1` makes one zip (the page, the two tools, what they
load) for a computer without MTB: copying `vezbi\` alone gives two empty tabs.

**Three addresses, three separate memories.** A browser keeps recordings and
chosen pictures per address, so what is recorded at `file://` is not there on
GitHub Pages or in the cloud, and the other way round. The words and the
pictures in `glasovi/` are the same everywhere; „⬇ Извези" is how a picture
chosen on one device reaches the rest. Pick one address per device and stay
on it — on the school PC that is the tile.

`npm run test:vezbi` (from `server/`) opens the page in a real browser through
the server's own file list: the tiles, the 26 sounds, both tools, a card onto
the board, Back, a phone's width. It needs no database.

## What the owner asked for next

More interactivity, combining this with ideas from their own ComuniBoard
(`ComuniBoard.html` in the folder above: an AAC card creator and a Cyrillic
letter board). The proposal as it was made to the owner; much of it has since
been built — „Where it stands" says what. For the rest, wait for „направи":

- **Dragging letters.** The child drags the missing letter into the empty box
  from a few tiles (the right one and two or three wrong ones). Right snaps
  in, wrong goes back.
- **Cyrillic on-screen keyboard** for the blanks-only step.
- **Pictogram search** (the ARASAAC API, as ComuniBoard's „Пиктограми" tab
  does), so the owner adds a word alone; an own photo is also possible.
- **Voice.** Tapping the picture says the word. Windows rarely has a
  Macedonian speech voice, so the therapist records the word once and it is
  kept with the card.
- **One set of words per sound** instead of one file per sound; the three
  cue steps are generated for every word.
- **The old decks are converted by the agent**, not retyped by the owner. The
  owner sends Dropbox links one at a time (`dl=1` on the link downloads the
  .pptx; it is a zip of XML and pictures).
- **A small reward** after a right answer: a star or a short animation, no
  score and no timer.

Suggested first step: dragging letters and the voice only, so the owner can
judge the direction before the rest is built.

## The three sources, and what to take from each

The owner (8 Oct 2026): combine the good parts of all three — this page,
ComuniBoard and WBACC Studio (their Excalidraw build, which they call proven).
All three are in this repository; nothing is copied into the page as a whole.
Take pieces, rewritten into the page.

| Source | Where | Take | Leave |
| --- | --- | --- | --- |
| This page | `vezbi/index.html` | the exercise itself: syllables, letter boxes, the fading cue, groups, worksheet | — |
| ComuniBoard | `ComuniBoard.html` | dragging letters with touch and mouse (`setupLetterDrag`), the Cyrillic on-screen keyboard (`renderKeyboard`), own photo with cropping (`initCropper`) | the free board, text boxes, lines, the presentation viewer |
| WBACC Studio | `wbacc/src/` | pictogram search, Macedonian then English (`Pictograms.jsx`, `api.js`); the picture stored INSIDE the card so it shows offline (`image.js`); the voice picker, Macedonian or the nearest Slavic voice; the ARASAAC credit (`Credit.jsx`) | Excalidraw itself |

Since 8 Oct 2026 WBACC Studio opens as a tab, whole, in a frame (see „The
three parts"). Excalidraw is still not built into the exercise itself: it is a free canvas (nothing snaps into a box, nothing is
right or wrong), it needs React and a Vite build, and `WBACC.html` is 8.6 MB
against this page's 0.2 MB. What a child would use it for in this exercise —
tracing or writing the letter with a finger — is a small pen layer on a
plain canvas. Why Excalidraw was chosen for WBACC, and how its fonts work
offline, is in `docs/PLAN-wbacc.md`.

## Pictures

All pictures are ARASAAC pictograms, one style. The credit line at the bottom
of the page is required by the licence (CC BY-NC-SA) and must stay:
„Пиктограми: Sergio Palao. Извор: ARASAAC (arasaac.org). Лиценца: CC BY-NC-SA.
Сопственик: Влада на Арагон (Шпанија)."

- Search: `https://api.arasaac.org/api/pictograms/mk/search/<word>` (Macedonian
  keywords work; `en` finds more).
- Image: `https://static.arasaac.org/pictograms/<id>/<id>_500.png`.
- Ids used for П: па-па 5896, пи-пи 2533, поп 30822, пау 2831, пее 2315,
  опа 28441, пие 2276.

Do not copy the pictures out of the old decks into this repository: they are
clipart of unknown origin and one is a photograph of a real person.

Open choices the owner has not answered:

- „поп" shows a priest in a Western collar; ARASAAC has no Orthodox priest.
- „пау" is a pistol, as in the original deck.

## Rules

- **Offline, no installation.** It must open by double-click on a school PC
  and on a phone. No build step the owner has to run, no server.
- **No child's name or recording in the repository.** It is public (rule 1
  of `CLAUDE.md`; the pre-commit hook checks names). Anything recorded with a
  child stays in the browser on that device.
- **Interface text is Macedonian (Cyrillic); code and comments are English.**
  The owner writes in English or in Macedonian with Latin letters.
- **A question from the owner is not a go-ahead.** They think aloud. Answer,
  say what you would build, and wait for „направи".
- **Publishing is a separate step.** A push to `main` puts the page on GitHub
  Pages; the cloud shows it after Render → Manual Deploy. Do neither until the
  owner asks.
- A `<button>` does not inherit `color`: give any element with its own
  background its own text colour too.
- Check a change in a browser at desktop and phone width before saying it
  works.
