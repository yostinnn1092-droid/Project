import fs from 'fs';
import path from 'path';

// three.js is MIT, and MIT requires its notice to travel with every copy. The
// vendor bundle is minified, so the header is gone from it — emitting the
// notice here means a re-bundle cannot silently drop it.
const THREE_LICENSE = `/*!
 * three.js r185 — https://threejs.org/
 *
 * The MIT License
 *
 * Copyright © 2010-2025 three.js authors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */
`;

const here = path.dirname(new URL(import.meta.url).pathname);

// Shared with the other game in this repo rather than copied. 842KB of
// somebody else's work does not want two lives in one tree, and a second copy
// is a second thing to keep licensed and up to date.
const VENDOR = path.join(here, '..', '..', 'game', 'vendor', 'three-bundle.js');

// Sources are numbered so the concatenation order is the file listing, and are
// kept small on purpose — one 1500-line game.js is how a project stops being
// reviewable.
const srcDir = path.join(here, 'src');
const parts = fs.readdirSync(srcDir).filter(f => f.endsWith('.js')).sort();
if (parts.length === 0) throw new Error('no sources in src/');

let game = parts
  .map(f => `\n// ─────────────────────────────────── ${f}\n` + fs.readFileSync(path.join(srcDir, f), 'utf8'))
  .join('\n');

const out = process.argv[2] || 'arena.html';

// A probe is appended INSIDE the IIFE, so a test can reach everything the game
// can and nothing has to be exported for testing's sake.
if (process.argv[3] === 'probe') {
  const probePath = process.env.PROBE || path.join(here, 'test', 'probe.js');
  game += '\n' + fs.readFileSync(probePath, 'utf8') + '\n';
}

const shell = fs.readFileSync(path.join(here, 'shell.html'), 'utf8');
const three = THREE_LICENSE + fs.readFileSync(VENDOR, 'utf8');
const wrapped = '(() => {\n"use strict";\n' + game + '\n})();';

const html = shell.replace('/*__THREE__*/', () => three).replace('/*__GAME__*/', () => wrapped);
fs.writeFileSync(out, html);
console.log(out, html.length, 'sources:', parts.length, 'probe:', /__probe/.test(html));
