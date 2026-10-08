# Artikulacija — articulation exercises for a speech therapist

This file is the project's memory. A new session knows nothing of the
conversation in which the project started (8 Oct 2026, inside the MTB
repository), so everything decided there is written here.

## What this is

The owner is a speech therapist at a school in Битола. About twenty years ago
they made a set of PowerPoint decks, one per speech sound, to practise
articulation with children. This project replaces those decks with one offline
web page that does the same exercise better. It is a separate project on
purpose: it does not belong in MTB and shares no code or data with it.

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

`glas-P.html` is the first version, and the owner likes the concept. It is one
self-contained file (pictures embedded as data URIs) that opens by
double-click and works offline. It has:

- „Слогови": the syllable table as text; tapping a syllable marks it done.
- „Зборови": all words or one of the three groups.
- „Помош": Цел збор → Без П → Само цртички → Само слика. Every letter is a
  box, so the number of missing sounds is visible; target boxes keep a red edge.
- Tapping one picture moves only that word to its next step.
- „Сите заедно" / „Една по една" (arrows, also on the keyboard).
- „Измешај" and „Работен лист" (print, A4, with name and date lines).

The words, syllables and target letter are data at the top of the script
(`TARGET`, `SYLLABLES`, `WORDS`, `IMG`). Nothing is stored between visits.

## What the owner asked for next

More interactivity, combining this with ideas from their own ComuniBoard
(`https://assisstant.github.io/MTB/ComuniBoard.html`, source in the MTB
repository as `ComuniBoard.html`: an AAC card creator and a Cyrillic letter
board). The proposal made to the owner, **not yet approved** — wait for
„направи" before building:

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
All three are readable on this machine in the sibling clone `..\MTB`; nothing
needs to be copied here as a whole. Take pieces, rewritten into this page.

| Source | Where | Take | Leave |
| --- | --- | --- | --- |
| This page | `glas-P.html` | the exercise itself: syllables, letter boxes, the fading cue, groups, worksheet | — |
| ComuniBoard | `..\MTB\ComuniBoard.html` | dragging letters with touch and mouse (`setupLetterDrag`), the Cyrillic on-screen keyboard (`renderKeyboard`), own photo with cropping (`initCropper`) | the free board, text boxes, lines, the presentation viewer |
| WBACC Studio | `..\MTB\wbacc\src\` | pictogram search, Macedonian then English (`Pictograms.jsx`, `api.js`); the picture stored INSIDE the card so it shows offline (`image.js`); the voice picker, Macedonian or the nearest Slavic voice; the ARASAAC credit (`Credit.jsx`) | Excalidraw itself |

Excalidraw is not embedded here, and that is a recommendation the owner has
not yet confirmed: it is a free canvas (nothing snaps into a box, nothing is
right or wrong), it needs React and a Vite build, and `WBACC.html` is 8.6 MB
against this page's 0.2 MB. What a child would use it for in this exercise —
tracing or writing the letter with a finger — is a small pen layer on a
plain canvas. Why Excalidraw was chosen for WBACC, and how its fonts work
offline, is in `..\MTB\docs\PLAN-wbacc.md`.

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
- **No child's name or recording in the repository.** It is on GitHub
  (`Assisstant/Artikulacija`). Anything recorded with a child stays in the
  browser on that device.
- **Interface text is Macedonian (Cyrillic); code and comments are English.**
  The owner writes in English or in Macedonian with Latin letters.
- **A question from the owner is not a go-ahead.** They think aloud. Answer,
  say what you would build, and wait for „направи".
- **Publishing is a separate step.** Do not push or turn on GitHub Pages
  until the owner asks.
- A `<button>` does not inherit `color`: give any element with its own
  background its own text colour too.
- Check a change in a browser at desktop and phone width before saying it
  works.
