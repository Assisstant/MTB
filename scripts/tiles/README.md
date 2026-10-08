# The pictures on the Контролна табла's tiles

One picture per record screen, shown on its tile in the „Евиденција" tab
(`Thumb` in `scripts\mtb-actions.ps1`). The three for the „Вежби" tab are the
exercise page's own, in `vezbi\`.

**This repository is public. Every picture here is a screen filled with
invented people by a test — never a screenshot of the work.** A picture taken
from the real S-Дневник would put pupils' names on the Internet as surely as
text would, and the name check (`npm run check:names`) reads text, not pixels.

## Making them again

From `server\`, with a browser (`CHROME=<path to chrome.exe>` where
Playwright's own is not installed), each suite saves its screen into `SHOT`:

| Picture | Suite | Saved as |
| --- | --- | --- |
| `s-dnevnik.jpg` | `node test/sdnevnik-weeks.browser.mjs` | `sdnevnik-week-copy.png` |
| `kabineti.jpg` | `node test/fusion-class-week.browser.mjs` | `class-week-light.png` |
| `nastava.jpg` | `node test/class-sheet.browser.mjs` | `class-sheet-all.png` |
| `uredi-nastava.jpg` | `node test/class-form.browser.mjs` | `uredi-nastava.png` |
| `spisoci.jpg` | `TWINS_SHOTS=<folder> node test/podatoci-twins.browser.mjs` | `twins-light.png` |
| `evidenten-list.jpg` | `npm run test:scratch -- test/evidence.browser.mjs` | `evidenten-list.png` |

The first five answer every API call themselves. The last needs a database
and gets a schema and a server of its own from `test:scratch`, dropped after —
never the work's.

Then `make.mjs` crops them to 660×300, the shape of the picture on a tile:

    node scripts/tiles/make.mjs <path to server> <folder with the PNGs> scripts/tiles
