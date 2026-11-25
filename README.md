# Anatomy Viewer

The main application is the offline-first anatomy viewer in `Anatomysource`.

## Run locally

Install its dependencies once, then start it from the repository root:

```sh
npm install --prefix Anatomysource
npm run dev
```

Vite prints the local URL. Models are loaded locally in the browser.

## Build and preview

```sh
npm run build
npm run preview
```

`npm run build` builds the viewer using the checked-in WASM module. To rebuild
the WASM module from C, run `npm --prefix Anatomysource run build` (requires
Emscripten).

The original React Router starter can still be run with `npm run dev:router`.

Cloudflare deployment uses the static viewer build in `Anatomysource/dist`.
Large GLB models are split into files under Cloudflare's 25 MiB asset limit
and joined in the browser when loaded. Run `npm run build` before `npm run deploy`.
