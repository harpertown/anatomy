# Complete Anatomy to WebAssembly: Port Plan

## Scope and evidence

This is a clean-room browser implementation, not a binary recompilation of the installed macOS app. The installed build is ARM64 native code plus a prebuilt JavaScript layer and a 435 MB `Assets.wcar` container. It exposes no buildable native source or WebAssembly module. A supported model cluster has now been converted to GLB.

The user's stated rights to the anatomy models are accepted for this task. The bundle's `Assets.wcar` index contains the Male 2024 model (`629250ec501a0ed64e00bf2e632c09a4`, version `206265414`) and a separate Cardiac Striated Muscle model (`74a18d2bf604d896e4521b113074ee79`, version `171871483`). The heart MVP was extracted from the Male 2024 model's Heart cluster. No app code or native executable is copied into this project.

## Heart MVP milestone

The first usable milestone is a heart-focused viewer. It now loads 24 offline model choices from the two complete body packs: separate male/female hearts and all 11 body systems for each model.

- Heart focus matches `heart`, `cardiac`, `atrium`, `ventricle`, `myocard`, `coronary`, and `pericard` names in the imported hierarchy.
- Preserve selected structure and layer visibility; the converted heart retains its nested source cluster hierarchy and source IDs, with collapsible groups and hierarchy-aware search.
- Show geometry and triangle counts without inventing anatomical labels or measurements.
- Keep all model processing local.

The app stores model payloads in a version-5 `strct` pack. Its table points at glTF, vertex, index, and morph files. Text/metadata payloads use the repeating `strct4` transform, while raw geometry buffers must be copied unchanged; applying that transform to vertex bytes corrupts the coordinates. `tools/unpack_wcar.py` implements extraction for a selected model ID; `tools/extract_wcar_resource.py` extracts the top-level language catalog. That embedded English catalog maps every structure CID in the two complete body packs, including all 48 heart structures. `tools/make_heart_glb.py` preserves the source anatomical name, subgroup path, source ID, 11 morph targets, and source 31-frame animation for each heart part.

The installed app includes the original DXT1 texture payload at `Resources/dds/97011e9ced214718b089dd41ea34bfcf.bin` (787,512,320 bytes), referenced by the Male 2024 heart glTF as buffer 9. `tools/extract_heart_dds_textures.py` reads the heart material bufferViews, decodes five original albedo and normal atlases, and exports browser-ready 1024×1024 PNGs. The app's shipped GLSL explains its packed 2×16 octahedral normals, packed 10:10:10:2 tangents, GGX microfacet terms, optional per-material overlay mix, and exponential HDR tone curve. `MaterialBuffer.h` places `overlayVisibility` on each material; `MainShader.fsh` samples the overlay only when `USE_OVERLAY` is enabled. The viewer's single global fill control is an approximation and defaults to zero, consistent with two ordinary-scene samples; their offsets are not heart material IDs. A separate `.96676` Pain-tool sample is excluded from the default. The ordinary-scene sample with metallic 0, roughness `.07999`, and reflectance `.28284` uniquely matches source material `5e2a0a0ed9dc83cbb322ca235d968174`; its runtime normal intensity `[1,1]` is applied to that material, with the match inferred from its unique source signature. The viewer retains glTF normal scale `-1.5` for other materials whose runtime normal intensities are not captured. `tools/make_heart_glb.py` decodes the packed normals and tangents into ordinary glTF float attributes, which lets Three.js apply all five original normal atlases in tangent space instead of baking their lighting into color, and carries source opacity values into the GLB. `tools/extract_iblenv.py` emits a Radiance preview of the environment; `tools/extract_iblenv_payloads.py` also preserves the app's diffuse cube, prefiltered specular cube mips through 16px, and RG16F BRDF LUT. The runtime PBR shader directly samples those stored payloads, so the bake-time `IBL_HARD_CORRECTION_LEVEL` is embodied in the extracted maps and is not a missing live uniform. The browser samples those original IBL payloads with the source roughness LOD scale and BRDF equations. For extracted heart materials, it also replaces Three.js direct-light accumulation with the source shader's GGX distribution, Smith visibility, Schlick Fresnel, and Lambert diffuse factor. A read-only capture of the running app's LightsBuffer recovered three directional lights with directions `[-0.586517, 0.732959, 0.344628]`, `[0.710924, 0.015361, 0.703101]`, and `[0.930026, -0.075524, -0.359650]`, intensities `1.8`, `0.5`, and `1.3`, ambient RGB `0.4`, and identity IBL rotation. These values now drive the viewer. The live exposure scalar and `invGamma` vector remain unverified. The Tune popover allows persisted exposure, overlay, and IBL-strength calibration. The source morph sequence is exposed as a looping heart cycle at 30 frames per second and starts paused for a stable initial view.

## Viewer foundation

Create a local-first anatomy workspace with:

- WebAssembly geometry core for computing scene bounds and normalizing imported meshes.
- Three.js renderer and glTF 2.0 loader bundled into the static app.
- Local import of GLB, or glTF plus its referenced files.
- Scene tree, search, selection, isolate/hide, reset view, orbit, pan, and zoom.
- Local-only operation after build; no account, telemetry, or remote model requests.
- Empty state that directs the user to the offline model library or local model import.

## Representation and parts list

Representation is literal anatomy from the user's imported 3D model. The viewer preserves the imported mesh and names present in the converted asset; it does not claim that a model is anatomically validated. No anatomy geometry will be invented to fill the unavailable catalog.

The model tree is data-driven. For each imported scene, show named nodes and meshes; support selection, visibility, isolation, and material emphasis. Preserve node names and source hierarchy as provided by the model. For converted structures, names are resolved from the bundled English catalog and keyed by CID; source IDs are retained as metadata. Display measurements only when the asset includes trustworthy units/metadata.

## Design direction

- **Palette:** ink blue `#101B26`, deep slate `#172A39`, bone `#E7E2D8`, vessel coral `#D87166`, arterial cyan `#5BA7B4`, muted sage `#9BAF9B`.
- **Type:** system sans for readable controls; a compact serif face for the anatomy title only.
- **Layout:** compact instrument rail and structure tree at left, large neutral viewport in the center, selected-structure inspector at right. Keep the model as the visual focus.
- **Principles:** quiet clinical workspace; named controls; no decorative measurements; no simulated anatomy; local file handling only.

## Expansion required for a full app conversion

The `Assets.wcar` table exposes 49 model directories, but only the Male 2024 and Female 2024 directories include the vertex/index/morph buffers needed for complete geometry in this install. Those packs now yield a 24-choice offline catalog in `public/models/catalog.json`; the app loads one GLB at a time. `public/models/heart.glb` remains the startup model. Alternate material texture encodings and original renderer behavior remain unavailable. Other model records need their missing mesh payloads. Lessons, animation sequences beyond the heart morph cycle, account/licensing services, and the original renderer also remain beyond this conversion.
