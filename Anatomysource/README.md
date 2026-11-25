# Forme Anatomy Workspace

A local-first WebAssembly anatomy model viewer. It loads user-supplied GLB files, or glTF files together with their referenced buffers and textures. Imported content stays in the browser and is not uploaded.

The heart MVP has expanded into a local anatomy library with **24 offline models**: male and female 2024 hearts, plus 11 body-system models for each. The standalone [heart GLB](public/models/heart.glb) contains 48 mesh parts and the source 31-frame morph cycle, with play/pause in the viewer. The heart uses the original albedo and normal atlases, source-compressed vertex normals and tangents decoded to standard glTF attributes, the app's `cape_hill` diffuse and prefiltered specular cubemaps plus its BRDF lookup texture, source reflectance values, and the source exponential tone curve. For extracted heart materials, the viewer also replaces Three.js direct-light accumulation with the app's shipped GGX distribution, visibility, and Fresnel equations, using the captured live directional light vectors and colors. The cycle starts paused so the heart is stable for inspection. Structure names come from the app's embedded English anatomy catalog, mapped by structure CID; source IDs remain available in the inspector.

## Build for offline use

Requirements: Node.js, npm, and Emscripten (`emcc`) on the build machine.

```sh
npm install
npm run build
npm run preview
```

Open the local URL printed by `npm run preview`. The production files in `dist/` are self-contained and include the WebAssembly geometry core and bundled renderer. Serve them with a local static HTTP server; browsers generally block WebAssembly fetches from `file://` URLs.

## Load models

- Choose one `.glb` file, or choose a `.gltf` plus all referenced `.bin` and image files.
- Drag the same files onto the viewport.
- The extracted heart loads automatically at startup; choose any other bundled system from the Offline Model Library.
- Use the tree search, eye buttons, inspector, and orbit controls to inspect the imported scene. Use Play beat / Pause beat to control the heart's morph cycle.
- Save a PNG of the current view with the camera button.

## Rebuild the offline model library

Decoded source packs are kept under `assets/source/`. Extract both complete body packs and regenerate all system GLBs with:

```sh
python3 tools/unpack_wcar.py \
  --pack "/Applications/Complete Anatomy.app/Contents/Resources/Assets.wcar" \
  --model-id 629250ec501a0ed64e00bf2e632c09a4 \
  --out assets/source/male-2024
python3 tools/unpack_wcar.py \
  --pack "/Applications/Complete Anatomy.app/Contents/Resources/Assets.wcar" \
  --model-id 964db2dd4f98052f03baa9ca5f2dbcae \
  --out assets/source/model-964db2
python3 tools/extract_wcar_resource.py \
  --pack "/Applications/Complete Anatomy.app/Contents/Resources/Assets.wcar" \
  --resource en.json \
  --out assets/source/en.json
python3 tools/build_offline_catalog.py
```

For imported glTF files, the viewer preserves the supplied hierarchy and names. Converted body systems retain the source structure names and IDs; the heart GLB also preserves nested anatomical cluster groups, with collapsible tree rows and search through the hierarchy. The heart includes the source 31-frame morph cycle. The original DXT1 texture payload is available at `/Applications/Complete Anatomy.app/Contents/Resources/dds/97011e9ced214718b089dd41ea34bfcf.bin`; the extractor recovers all five heart albedo and normal atlases plus the heart filling layers. `tools/make_heart_glb.py` decodes the app's packed octahedral vertex normals and 10:10:10:2 tangents according to its shipped GLSL, allowing Three.js to apply the original normal atlases dynamically. It also carries the source opacity values. A live MaterialBuffer sample's metallic/roughness/reflectance signature uniquely matches source material `5e2a0a0ed9dc83cbb322ca235d968174`; its captured normal intensity `[1,1]` now overrides the glTF normal scale `-1.5` for that one material. The identity match is inferred from the unique material signature, since the captured buffer offset itself is not an ID. The `cape_hill.iblenv` payload is extracted into the original 128px diffuse cubemap, 512px prefiltered specular cubemap (mips through 16px), and 256px RG16F BRDF lookup texture; the viewer applies the app's source-style IBL equations to these textures rather than Three.js-generated replacements. Read-only sampling of the live app's LightsBuffer recovered three directional lights (directions `[-0.586517, 0.732959, 0.344628]`, `[0.710924, 0.015361, 0.703101]`, and `[0.930026, -0.075524, -0.359650]`, with white intensities `1.8`, `0.5`, and `1.3`), ambient RGB `0.4`, and identity IBL rotation; these now drive the viewer. The viewer also uses shipped GGX material values and the exponential tone curve. Ordinary-scene MaterialBuffer samples show overlay visibility `0`; their other buffer offsets are not mapped to heart material IDs. A separate `.96676` Pain-tool sample is excluded from the default. Exposure has not yet been recovered from the live app. The Tune popover exposes persisted exposure, overlay, and IBL strength adjustments for direct visual calibration; reset restores the current estimates. Generated cardiac tissue maps remain fallback materials. The viewer normalizes camera framing in the WebAssembly core but does not rewrite imported files. This app does not validate anatomy.

To regenerate the bundled heart texture PNGs from the locally installed app, run:

```sh
python3 tools/extract_heart_dds_textures.py \
  --model-dir assets/source/male-2024 \
  --dds-resource "/Applications/Complete Anatomy.app/Contents/Resources/dds/97011e9ced214718b089dd41ea34bfcf.bin" \
  --out-dir public/models/textures
python3 tools/build_offline_catalog.py
```

The source atlases are 2048×2048 DXT1; this workflow downsamples the exported PNGs to 1024×1024. Regenerate the app's local IBL environment with:

```sh
python3 tools/extract_iblenv.py \
  --input "/Applications/Complete Anatomy.app/Contents/Resources/cape_hill.iblenv" \
  --output public/models/environments/cape_hill.hdr
python3 tools/extract_iblenv_payloads.py \
  --input "/Applications/Complete Anatomy.app/Contents/Resources/cape_hill.iblenv" \
  --output-dir public/models/environments
```

Regeneration requires the app resources and `ffmpeg`.

The live exposure scalar remains an estimate (`0.85`), and the runtime `invGamma` vector is not recovered yet. `IBL_HARD_CORRECTION_LEVEL` is used while generating the environment maps; the viewer samples the app's already-prefiltered diffuse/specular cubes and BRDF lookup, so that bake-time constant is already embodied in those source textures. Do not treat screenshots tuned with the Tune popover as source captures.

## Porting boundary

The installed Complete Anatomy bundle contains a native macOS executable, a prebuilt web layer, and the custom `Assets.wcar` pack. This project converts the two complete bundled body packs into offline GLB anatomy systems. Raw vertex/index/morph buffers must be copied as-is; applying the repeating `strct4` transform corrupts their coordinates. Many other model records are indexed in the pack but lack their mesh buffers in this installation. The extraction utilities are in `tools/`; see [PORT_PLAN.md](PORT_PLAN.md) for evidence and remaining work.
