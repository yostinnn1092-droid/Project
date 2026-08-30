import fs from 'fs';

// three.js is MIT, and MIT requires its notice to travel with every copy of the
// code. Minifying the vendor bundle strips the header, so the notice is emitted
// here instead of living in vendor/three-bundle.js — a re-bundle would silently
// drop it there, and shipping 800KB of somebody's work with their name removed
// is not a thing to leave to whether the next person remembers.
const THREE_LICENSE = `/*!
 * three.js r185 — https://threejs.org/  (bundled: core + examples/jsm postprocessing)
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

const shell = fs.readFileSync('shell.html','utf8');
const three = THREE_LICENSE + fs.readFileSync('vendor/three-bundle.js','utf8');
let game = fs.readFileSync('game.js','utf8');
const out = process.argv[2] || 'out.html';
if (process.argv[3] === 'probe') {
  const probe = fs.readFileSync(process.env.PROBE || 'probe.js','utf8');
  const tail = '})();';
  const i = game.lastIndexOf(tail);
  if (i < 0) throw new Error('IIFE tail not found');
  game = game.slice(0, i) + '\n' + probe + '\n' + game.slice(i);
}
const html = shell.replace('/*__THREE__*/', () => three).replace('/*__GAME__*/', () => game);
fs.writeFileSync(out, html);
console.log(out, html.length, 'probe:', /__probe/.test(html));
