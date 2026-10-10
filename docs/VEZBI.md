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

### Proposed content navigation, reusable cards and diary links (10 Oct 2026)

The owner's next request and the code review are in
[PLAN-sodrzini-karticki-i-planovi.md](PLAN-sodrzini-karticki-i-planovi.md).
This is a **proposal, not implemented**: visible content sections, structured
card editing through the existing creator, one personal stamp library, and
content-only deep links from diary plan activities. No pupil information
crosses into exercise pages. Opening an exercise never credits attendance.
The owner confirmed 76 treatments per pupil per year, initially two per week;
both are individually editable planning targets. No live plans were assigned.

### Separate Word alphabet exercises and ready stamps (10 Oct 2026)

The owner approved ARASAAC categories based on their Word document, explicitly
keeping the already-made sound exercises separate. **„Букви и зборови“** is a
third section in the first picker, beside **Гласови** and **Теми**. The original
26 decks, syllables, groups and 11 themes have not been rewritten.

- **31 categories / 149 terms** from a reviewed interpretation of the Word
  pictures. „Од Word“ opens the source category. „На почеток / Во средина /
  На крај“ searches the whole NEW catalogue for that sound position, at word
  boundaries; a repeated sound can put a term in more than one position.
  „Сите со…“ shows every matching term. Њ → крај includes коњ; средина includes
  дуња and молња. Empty choices say that the current collection has no term.
- The same word/target-letter/blanks/picture steps, keyboard, drag-only tiles,
  quiet feedback, print and ComuniBoard transfer remain. No invented syllable
  exercises for the alphabet section. Replacements are scoped to `letters-NN`;
  old sound recordings keep their old keys. Images use stable `letters:word-ID`
  keys, shared across letter views of the same catalogue item.
- All 149 pictures are embedded official ARASAAC artwork, visually checked in
  contact sheets. All 149 MP3s use Marija, the existing −10% synthesis setting,
  with the shared 0.75× playback default. Both assets work offline. ARASAAC
  credit is retained; the original mixed clipart and Word document stay local.
- `letters-manifest.json` owns vocabulary, source categories, pictogram IDs and
  editorial notes. `scripts/vezbi-letters.py --apply` makes `bukvi.js` and
  `audio/letters.js`; `letters.js` derives exercise views and sound positions.
  WBACC imports these same assets at build time, so no second maintained list
  and no runtime dependency on a neighbouring folder in standalone WBACC.
- Six source concepts await an exact pictogram: **ѓум, ѓезве, ждребе, ќебапи,
  ќумбе, фазан**. They are in `pending`, not represented by misleading search
  results. The Word template contains repeated unrelated sentences; those
  were not imported. Clock is часовник (С in the middle), not саат. Two child
  figures under Љ were adapted to љубопитност/љубезност rather than assigning
  personal names. Њујорк uses the Statue of Liberty as in the source. Review
  these vocabulary choices with the therapist before treating them as final.

WBACC → **Печати** has the same categories and position filters, search, word
on/off, editable label, size, listen/stop/mute and placing into the drawing.
„Постави со допир“ enters an explicit repeat mode: click/tap places a stamp,
mouse movement previews its image, a drag does not stamp; Done/Escape ends it.
Enter/Space places centrally. Copies have separate IDs/groups and one Undo
removes one whole image/text card; the drawing retains its image on reload.
Ready categories are bundled, not a new user-authored library. Saving custom
groups/categories and library import/export remain later work in
[PLAN-wbacc-pecati.md](PLAN-wbacc-pecati.md).

`test:vezbi-letters` checks real image/audio decoding, isolation from existing
decks, positional matching, scoped imports/export, keyboard completion, empty
states, phone layouts, shared stamp audio/mute, persistence, Undo/Redo, real
touch tap vs drag and `file://`: **35 checks passed**. Existing audio (32),
themes (26), feedback (34), main exercise and WBACC suites also passed, as
did all 388 server unit checks. Screenshots: ignored `backups/letters-review/`.
Offline ZIP rebuilt and checked against the current assets: 21.6 MB / 75 files.

### Thematic vocabulary from the owner's slides and narration (10 Oct 2026)

The owner supplied a PowerPoint with 11 slides and their own YouTube voiceover,
said to build it, made nine videos public, then explicitly approved Marija for
anything unavailable. The supplied clothes link still answered “Private video”
on 10 October. There was no small-animal recording and the school video omits
the slide's “диск”. No private account or browser cookies were used.

- **11 themes / 152 terms**, alongside the original 26 sounds, in the SAME
  engine: open the first selector → **Теми**. Body parts, domestic animals,
  wild animals, small animals, kitchen utensils, furniture/home objects,
  clothes/footwear, fruit, vegetables, hygiene, school equipment.
- Themes start at words, with **Цел збор → Само цртички → Само слика**;
  no meaningless syllables or “Без [letter]” stage. Existing drag-only tiles,
  keyboard, stationary star, single-card/grid views, print and ComuniBoard
  transfer remain. Multiword terms wrap at spaces; long letters fit their boxes.
- **121 clips from the owner's nine public videos; 31 Marija clips.** The
  recording order was checked against local Whisper transcription, then each
  speech region was cut with 250 ms before / 300 ms after it. Word positions
  were NOT inferred from slide XML order. Two omitted recognitions in the wild
  animal transcript were checked separately. Automated recognition and decoding
  do not constitute a therapist's listening review of every pronunciation.
- Marija covers clothes, small animals, “диск” and four editorial corrections:
  пајка → патка, супиена лажица → супена лажица, сат → часовник,
  роквица → ротквица. Spacing is also corrected in бубамара and лаптоп;
  лаптоп retains its original recording. The original label, picture ID and
  exact audio provenance/times live in `vezbi/themes-manifest.json`.
- All 152 pictures were inspected as contact sheets and ambiguous search
  results corrected (e.g. fly/insect, soap/action, pot/watering can). **151
  ARASAAC entries and one generated ѓезве illustration**: the latter has its
  own credit, source and generation prompt in `vezbi/images/README.md`.
  Original slide clipart stays out of Git.
- `temi.js` embeds the pictures; 11 lazy `audio/theme-*.js` bundles embed MP3s.
  The explicit server allowlist and offline ZIP include them. Nothing contacts
  YouTube, ARASAAC or a speech service during exercise playback.
- Audio editor labels author/Marija/personal recordings. Playback speed and mute
  are shared with sounds. Personal replacements AND pictures use a theme prefix,
  so the hygiene brush does not replace the school paintbrush. Legacy sound
  recordings keep their exact-text keys. JSON audio packs still transfer one
  selected catalogue only; a mismatched theme is refused.

Build: `python scripts/vezbi-themes.py` previews; `--apply` requires the supplied
MP3s in ignored `backups/body-parts-source/`, ffmpeg, Pillow and edge-tts. It
uses the reviewed manifest and cached official pictograms, then publishes
complete bundles. No downloader or credentials in the script. It also creates
`backups/body-parts-source/Temi-audio.zip`: named MP3s by theme and 11 importable
JSON packs. `scripts/vezbi-zip.ps1` packages the whole offline application.

Validation: `test:vezbi-themes` decodes all 152 images and MP3s, exercises the
picker, spelling, provenance, isolated recording imports/reload, speed/mute,
phone bounds and `file://`. Desktop and phone screenshots were inspected.
The existing `test:vezbi`, `test:vezbi-audio` and `test:vezbi-feedback` cover the
surrounding tools, sound decks and child-facing behavior.

### A tile is placed only by dragging (9 Oct 2026)

The owner, after trying it in the cloud: only drag and drop may put a letter
on its box, not a plain click. A click, a touch or Enter on a tile under a
card now does nothing; the tile is dragged, in „Без П" and in „Само цртички".
With tiles no box carries the blue ring, and the hint says „Повлечи…".

**Read narrowly, to be confirmed:** „⌨ Тастатура" still types on a tap (and
from the real keyboard), because a keyboard that must be dragged is not a
keyboard; its keys can also be dragged, as before. If the owner meant the
keyboard too, the line to change is the `if (i !== null) return;` in
`draggable`. With tiles there is now no way to place a letter without a
pointer; the keyboard is that way.

`test:vezbi-feedback` (34 checks) drags every tile — a finger's drag as real
touch points — and checks that a click, a touch and Enter place nothing; the
check fails against the page as it was. It takes `CHROME=<path>` like
`test:vezbi`.

### Stable cards and gentle completion feedback (9 Oct 2026)

The owner asked for child-friendly behavior in the ComuniBoard/exercise suite:
no cards falling to another place when completed, a slight turn and a star.
The actual completion defect was in `vezbi/index.html`: `.card.pop` shared
`.pop` with the toolbar menus, so a successful card acquired popup positioning.
Never reuse the menu class for feedback.

- Completion uses `.celebrate`: one 800 ms turn (−1.5°/+1°), up to 1.025 scale,
  a soft gold edge and a star. It returns to its place; adjacent cards never
  move. Letter entry refreshes only that card, preserving the rest of the DOM
  and scroll. The keyboard keeps its space after the last letter.
- During spelling, tapping the picture plays the pronunciation; it no longer
  erases the answer by cycling difficulty. Explicit ↺ restarts just that card;
  the existing „Помош“ controls choose the next difficulty. Opening a card
  large from the grid and Back remain unchanged.
- Shorter instructions leave room for the picture on low laptop screens.
  Wrong-answer feedback is gentler, with the existing hint after two tries.
- „⋯ → ☆ Без анимации“ persists on this browser (`vezbi_calm_v1`). A static
  star still rewards completion. System reduced-motion is respected too;
  see [W3C C39](https://www.w3.org/WAI/WCAG22/Techniques/css/C39.html).
- In **ComuniBoard itself**, selecting a letter/image/card no longer moves it
  on a small pointer wobble: dragging starts at 8 px. History captures its
  position BEFORE the first move, so one Undo restores it; Undo/Redo schedule
  autosave too. Existing grouping, snapping and the touch bridge stay in use.
- `test:vezbi-feedback` exercises real taps, pointer dragging, phone scroll,
  grid and single-card geometry, keyboard completion, quiet mode, the original
  popup-class failure as a control, and ComuniBoard drag/Undo/Redo/autosave.
  `test:vezbi` and `test:vezbi-audio` cover the surrounding tools and audio.

### Playback speed (9 Oct 2026)

The owner requested a speed slider. The bar's speed menu and the audio
editor share a **0.5–1.5×** slider in 0.05 steps. **10 Oct update:** the owner
requested a slower default: **0.75×**, also used by „Почетна · 0,75×“ reset.
Previously saved choices remain; a fresh browser starts at 0.75×. The label
shows the actual playback factor (0.75 is not relabelled as 1).
The choice persists on this browser (`vezbi_speech_rate_v1`). It applies to
bundled clips and personal recordings, including the currently playing clip,
with `preservesPitch=true`; the Macedonian native fallback uses the selected
factor on its next utterance. Downloads keep the original recording.
Keyboard, persistence, reset, actual playback rate and phone bounds are
covered by `test:vezbi-audio` (32 checks passed on 10 Oct, including the new
default); `test:vezbi` passed before this default-only change.

### Audio files and Macedonian pronunciation (9 Oct 2026)

The owner asked for a file per term, uploading replacements, and mute/listen.
They chose **Marija now, with Google recordings replaceable later** after
asking about NotebookLM voices. Gemini TTS supports Macedonian; API access is
separate from the consumer Pro subscription. No Gemini service was connected.

- **984 unique MP3s** cover the words, sentences and syllables of all 26 sounds
  (986 entries across decks). `mk-MK-MarijaNeural`, rate −10%, generated with
  `edge-tts` from the existing public exercise vocabulary only. Synthetic
  examples, not pronunciation reviewed by the therapist.
- `vezbi/audio/<sound>.js` embeds ONE sound's MP3s, loaded only when needed.
  All 26 total about 15 MB; works from `file://` too. `public-static.ts` names
  every bundle; `vezbi-zip.ps1` includes them and `audio.js`. No API key or
  network speech service in the page. Native fallback accepts only Macedonian,
  never Serbian/Bulgarian/Russian as a substitute pronunciation model.
- **🔊 / 🔇** in the bar remembers mute, stops playing immediately and covers
  completion feedback too. Opening never speaks. A syllable tap plays its clip;
  in edit mode it opens the audio editor instead. Playback never overlaps.
- **„Уреди → 🎧 Аудио“**: listen, stop, download, upload MP3/WAV/M4A/OGG/WebM
  (10 MB / 60 seconds), record up to 30 seconds, restore the built-in clip.
  Replacements stay in IndexedDB `voice`, keyed by exact text; success only
  after commit. Closing during recording cancels and releases the microphone.
- **„Извези аудиопакет“ / „Внеси аудиопакет“** in ⋯ transfers one sound as
  JSON, including syllables. Import checks the sound, terms and decoded audio
  before one atomic write; no imported scripts execute. It changes this device
  only. The original `glasovi/<sound>.js` export now includes audio too.
  Publishing exports remains a separate step; child recordings never enter Git.
- ARASAAC credit stays, with source and licence links.

Regenerate: `python scripts/vezbi-audio.py` lists the job; `--apply` generates
missing cached clips, then writes complete bundles. Originals and JSON packs
stay in ignored `backups/vezbi-audio/marija/`. The ZIP
`backups/vezbi-audio/Vezbi-Marija-audio.zip` has a searchable offline
`index.html`, all MP3s and the 26 JSON packs. `test:vezbi-audio` checks playback,
mute, persistence, rejected files, transfer, phone layout, real MediaRecorder
with a synthetic stream, complete terms and a decodable MP3 per sound, and disk
loading. It does not certify every synthetic pronunciation.

Sources: [Microsoft voices](https://learn.microsoft.com/azure/ai-services/speech-service/language-support?tabs=tts),
[edge-tts](https://github.com/rany2/edge-tts), [Gemini TTS](https://ai.google.dev/gemini-api/docs/speech-generation),
[Gemini API billing](https://ai.google.dev/gemini-api/docs/billing), [ARASAAC](https://arasaac.org/terms-of-use).

### Earlier exercise features

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
  goes back and shakes; a tap or Enter placed it without dragging until
  9 Oct 2026 (see above). When the word is whole it is said aloud.
- **Building the word** (8 Oct 2026, the owner said „направи", not yet
  judged): in „Само цртички" every box of a word takes a letter. Two levels:
  tiles under the card (the word's own letters, shuffled, and two wrong ones;
  a placed tile is gone), or „⌨ Тастатура" in the header — one keyboard for
  the whole screen, fixed at the bottom, in ComuniBoard's Macedonian layout.
  With the keyboard on it also replaces the three tiles of „Без П", and the
  real keyboard types into the same box. A letter is dragged into any box; a
  key of the keyboard (since 9 Oct 2026 not a tile) can also be tapped: it
  goes to the box with the blue ring (a box chosen by a tap, else the first
  empty one). After two wrong tries a box shows its letter
  faintly. A whole word is said aloud and gets a ⭐ (also in „Без П"). A tap
  on an empty box no longer moves the card to its next step; a tap on the
  picture does. Sentences do not have this yet („Без збор" is still a line).
  (Since the evening of 8 Oct the keyboard's button is in the one-row bar and
  a key is the size of a letter box: see „One row of controls".)
- **Voice**: the initial 8 Oct system-voice/5-second recorder is superseded
  by the 9 Oct audio workflow above. IndexedDB remains `artikulacija` / `voice`.
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

### A space between words (8 Oct 2026, late; the owner: „do it and push"; not yet judged)

The owner dropped letters into „пицатаевкусна" and asked whether the space bar
could make the gap, so that the sticky drop and „Порамни" respect it. A space
already was a letter nobody could see (`content: ' '`), from the wide key or
the real space bar; what was missing is below.

- **It is marked**: a faint „␣" in the colour of the letters
  (`.element-space::after`), stronger under the pointer and when chosen, so it
  can be seen, grabbed and deleted. The owner offered a letter's shadow or an
  underline; a plain line was turned down because on this board a line is
  where a letter is missing. Never in the saved picture (`.canvas.exporting`)
  or in print.
- **It is a third of the letter size** (`getLetterWidth`), where the font's own
  was a quarter. A space made before keeps its width until the next „Порамни".
- **„Порамни" and the spacing slider keep word gaps** (`keepWordGaps`): a gap
  left by hand becomes a real space when it is wider than the row's usual gap
  (the lower median) by 0.3 of the letter size. So letters dropped loosely are
  still one word, and two one-letter words with one gap between them cannot be
  told apart and stay closed. A space lying among the chosen letters is taken
  along even when the selection missed it (`withSpacesBetween`).
- **A letter dropped at the end of a word that ends in a space sticks after
  the space**; it used to land on top of it, and the gap was gone.
- **The key shows „␣"**, drawn, so it needs no font.
- **A deleted space takes its gap with it** (`closeGapOfSpace`; the owner, the
  same night: „if I delete it it should be deleted and poramni should ignore
  it"). The letters that follow it in the row move into its place, with
  „Избриши" and with ⌫ alike. In the first version the hole stayed, „Порамни"
  read it as a gap made by hand and put the space straight back. The same
  word: the mark is fainter (opacity 0.14, 0.6 when chosen; it was 0.3 / 0.85).
- **A fault found on the way and fixed:** the message at the bottom (`#toast`)
  took taps while unseen, and it lies over the middle of the keyboard's last
  row — a tap on the middle of the space key did nothing.
- Not built, on purpose: a letter dropped far from a word starting a new word
  by itself. It changes how dropping feels; the owner was told and did not ask.
- `test:vezbi` holds all of it (item 8 in its header).

### Copy and paste with WBACC Studio (8 Oct 2026, night; the owner: „do what is best practice and proven concept"; not yet judged)

The owner asked whether a picture chosen in ComuniBoard can be pasted into the
Studio and text chosen in the Studio into ComuniBoard. Until then Ctrl+C on
the board kept its copy in a variable of the page (`window._wbClipboard`), the
board took only pictures from the clipboard, and once anything had been copied
on the board Ctrl+V pasted that for ever — a screenshot no longer got in.

- **One clipboard, the computer's.** A copy on the board (`copySelection`,
  Ctrl+C or the new „Копирај" in the floating bar) goes there too: letters as
  text, row by row, with their spaces; a picture as a PNG; a card drawn as it
  looks, frame and word. The Studio (or Word) takes it with a plain Ctrl+V.
- **The copy carries a mark** (`data-comuniboard` in its `text/html`). A paste
  back on the board that finds its own mark brings the things themselves,
  with place, size and colour, as before. Anything else on the clipboard is
  from outside. `takeClipboard` is the one place that decides, for Ctrl+V and
  for the button.
- **From outside**: a picture is a picture; text lands as letters at the
  cursor, as if typed (the first 300, a new line is a new row), chosen so they
  can be moved at once. What the Studio copies with a plain Ctrl+C is its
  drawing written out as text (`excalidraw/clipboard`): the board takes the
  words and the pictures out of it (`readStudioCopy`) and says that shapes
  stay behind. The Studio itself was not changed and needs no build.
- **Two ways to write, on purpose.** Text and the mark go through the `copy`
  event (`writeTextToSystem`), which no browser asks leave for, in a frame and
  from the disk alike. A picture cannot go that way; it goes through
  `navigator.clipboard.write`, which a browser may refuse — then the copy
  stays on the board and a message says so.
- **The frames are given the clipboard by name**: `allow="clipboard-read *;
  clipboard-write *"` on the two frames here and on ComuniBoard's own board
  frame. Opened from the disk every page is an address of its own, and
  without the `*` the picture was refused there (measured: text crossed, the
  picture did not).
- **„Залепи" (📋) pastes**, where it only showed a hint; reading the clipboard
  from a button asks the browser's leave once. For a board without a keyboard.
- Left as it was: a copied text BOX (`type: 'textbox'`) is still the board's
  own, and looks, fonts and shapes do not cross.
- `test:vezbi` holds both directions through the real Studio (item 9).

**Tile pictures are taken from the disk, never through the local server.**
Through the server every page carries „изработил …" with a real name, and
`check:names` reads text, not pictures. `vezbi/tabla.jpg` was retaken that
way (the address `file://…/ComuniBoard.html`, the home dock hidden).

## The door from S-Дневник, and the way back (8 Oct 2026, night)

The owner, looking at the diary's „🎨 WBACC Studio ↗" in the cloud: „I think I
should have links to all the apps for vezbi here and from there to s dnevnik",
then „направи" for one door (the other choice was three).

- **S-Дневник has one door, „🗣 Вежби ↗"**, where the WBACC one was. It opens
  `vezbi/index.html` in a new tab: the three tiles, and the strip from one to
  the next. `rel="opener"` is there on purpose — a browser gives a new tab no
  opener unless asked.
- **„📓 S-Дневник" at the far end of the strip** (`diary()`), shown only where
  the diary really lives: the page asks `../api/health`, and only a server
  that answers gets the link. In the cloud (`cloudAuth: 'google'`) it leads to
  `MTB-Workspace.html?app=S-Dnevnik.html`, on a local server to
  `S-Dnevnik.html`. **Never on GitHub Pages or from the disk:** the
  S-Dnevnik.html there is a separate, empty copy that looks real (CLAUDE.md,
  „Which address people open"). From the Контролна табла tile (disk) the
  diary is on the „Евиденција" tab of the same window.
- **Opened through the door, the link closes the tab**, which returns to that
  diary as it was left, where a plain link would open a second copy of it.
  It knows through `window.opener`; without one it is an ordinary link.
- The page still holds nothing of the records: „is there a server" is all it
  asks. `test:vezbi` holds the door (read from the real S-Dnevnik.html), the
  link with and without a server, the closing, and the cloud's address.

## No dead ends (8 Oct 2026, night; the owner: „направи"; not yet judged)

The owner: „there should be a link navigation between all this 3 apps + back
to s dnevnik so I can navigate freely in and out and from one to another".
The strip already did that inside this page. The dead ends were the two tools
opened alone (the Контролна табла's own tiles opened them so) and the missing
„📓 S-Дневник" from the disk.

- **The three tiles of the Контролна табла open this ONE page**, each on its
  own part (`Part` in `scripts\mtb-actions.ps1`: `vezbi`, `tabla`, `crtanje`).
  A file opened through its association loses what follows „?" and „#", so
  `Open-File` in `mtb-launcher.ps1` hands the address to the browser's own
  program (`Get-BrowserProgram`, read from the registry). Where that is not
  found the page opens at its start, whose three tiles lead to the same parts.
- **Measured before changing the tiles:** from the disk, a board saved in
  ComuniBoard opened alone is there when it opens inside this page, and the
  Studio's database is the same one. A browser keeps the disk's pages together.
- **A tool opened alone has a way to the strip**, on its own part:
  „🗣 Вежби · WBACC Studio" at the end of ComuniBoard's own row, „🗣 Вежби"
  among the Studio's buttons and in its menu (a phone has no row of buttons).
  Inside the strip neither shows it. The start page and EduHub still open the
  tools alone; this link is their way on.
- **„📓 S-Дневник" from the disk.** The diary is in the cloud, and the cloud's
  address is not in this repository. The Контролна табла knows it
  (`MTB_CLOUD_URL` in `server\.env`) and hands it over in the address
  (`?oblak=https://…`); the page keeps it (`vezbi_oblak_v1`) for a
  double-click later and links to the work space's diary there, the same place
  as the tile on „Евиденција". **Taken from a page on the disk only**: on a
  public address anyone could hand in an address of their own under a link
  that says „S-Дневник".
- **Proposed and NOT built: the link through `start.html`** on GitHub Pages
  and on a disk that was never opened from the Контролна табла. The start page
  does not know the cloud; it finds a machine's LOCAL database, which is the
  mode for a day without Internet, and with no server it offers the empty copy
  of the diary. Both are what this link must never do, so there it is still
  absent.
- `test:vezbi` holds it (item 10), the disk in a browser context of its own.

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
the letter (а у е и о: start, middle, end). Personal voice recordings and
picture replacements are stored between visits.

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
   Internet or for the cloud to wake. (Since that night all three open this
   one page, each on its own part: see „No dead ends".)
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
