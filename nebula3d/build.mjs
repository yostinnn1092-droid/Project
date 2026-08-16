import fs from 'fs';
const here  = p => new URL(p, import.meta.url);
const shell = fs.readFileSync(here('./shell.html'), 'utf8');
const three = fs.readFileSync(here('../game/vendor/three-bundle.js'), 'utf8');
let game    = fs.readFileSync(here('./game.js'), 'utf8');
const out   = process.argv[2] || 'nebula3d.html';

if (process.argv[3] === 'probe') {
  const probe = fs.readFileSync(process.env.PROBE, 'utf8');
  const i = game.lastIndexOf('})();');
  if (i < 0) throw new Error('IIFE tail not found');
  game = game.slice(0, i) + '\n' + probe + '\n' + game.slice(i);
}

const html = shell.replace('/*__THREE__*/', () => three).replace('/*__GAME__*/', () => game);
fs.writeFileSync(out, html);
console.log(out, html.length, 'bytes · probe:', /__probe/.test(html));
