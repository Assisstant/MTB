// The built page is the one published file: ../WBACC.html beside the other apps.
import { copyFileSync, statSync } from 'node:fs';
copyFileSync('dist/index.html', '../WBACC.html');
console.log('WBACC.html', (statSync('../WBACC.html').size / 1048576).toFixed(2), 'MB');
