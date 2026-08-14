import fs from 'fs';
const shell = fs.readFileSync('shell.html','utf8');
const three = fs.readFileSync('vendor/three-bundle.js','utf8');
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
