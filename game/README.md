# Kinesis 3D — source

`kinesis3d.html` at the repo root is a build artifact. Edit the files here, then:

```
cd game && node build.mjs ../kinesis3d.html
```

- `shell.html` — page chrome, HUD, CSS, touch controls. Contains the two
  `/*__THREE__*/` and `/*__GAME__*/` placeholders the build fills in.
- `game.js` — the whole game, one IIFE.
- `vendor/three-bundle.js` — three.js 0.185.1 plus the post-processing passes,
  bundled to an IIFE that assigns `globalThis.THREE` and `globalThis.PP`.
  Vendored because the artifact CSP blocks every external host, so nothing can
  be loaded from a CDN at runtime.

The build is a plain string substitution: the output is a single self-contained
file with no external requests.
