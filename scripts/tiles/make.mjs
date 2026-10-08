// Crops the suites' invented-data screenshots to the tiles' pictures (README.md beside this file).
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [, , serverDir, shots, out] = process.argv;
const { chromium } = createRequire(join(serverDir, 'package.json'))('playwright');
const W = 660, H = 300;
// name, source picture, its width, and the row of it the crop starts at
const jobs = [
  ['s-dnevnik', 'sdnevnik-week-copy.png', 1280, 200],
  ['kabineti', 'class-week-light.png', 1400, 335],
  ['spisoci', 'twins-light.png', 1280, 55],
  ['nastava', 'class-sheet-all.png', 1420, 0],
  ['uredi-nastava', 'uredi-nastava.png', 1600, 45],
  ['evidenten-list', 'evidenten-list.png', 1440, 45],
];
const browser = await chromium.launch({ executablePath: process.env.CHROME });
const page = await browser.newPage({ viewport: { width: W, height: H } });
for (const [name, file, width, top] of jobs) {
  const k = W / width;
  const html = join(shots, name + '.html');
  writeFileSync(html, `<body style="margin:0;overflow:hidden;background:#fff"><img src="${pathToFileURL(join(shots, file))}" style="display:block;width:${W}px;margin-top:${-Math.round(top * k)}px">`);
  await page.goto(pathToFileURL(html).href);
  await page.waitForFunction(() => document.images[0].complete);
  await page.screenshot({ path: join(out, name + '.jpg'), type: 'jpeg', quality: 84, clip: { x: 0, y: 0, width: W, height: H } });
  console.log('made', name);
}
await browser.close();
