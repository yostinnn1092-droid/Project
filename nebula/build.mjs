import fs from 'fs';
const shell = fs.readFileSync(new URL('./shell.html', import.meta.url), 'utf8');
const game  = fs.readFileSync(new URL('./game.js',   import.meta.url), 'utf8');
const out = process.argv[2] || 'nebula.html';
const html = shell.replace('/*__GAME__*/', () => game);
fs.writeFileSync(out, html);
console.log(out, html.length, 'bytes');
