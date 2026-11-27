# Detailed model source copies

This folder contains the `model_description.json`, `assets.json`, and `assets.gltf` records extracted from the installed Complete Anatomy `Assets.wcar` pack for each standalone Detailed Model entry. Geometry buffers recovered from the local app cache are included where available.

The app cache contained vertex and index buffers for Blood, Blood-Air Barrier, and Synapse. Their exact buffers are included here. The corresponding preview files under `public/models/detailed/` omit image and texture bindings because those texture payloads were not present in the recovered cache. They preserve the model geometry for inspection. Preview nodes use the anatomy labels from the installed English catalog; their original app node and structure IDs remain in each node's glTF `extras`.

The Detailed Models gallery catalog lists all 38 standalone entries and shows whether local geometry is available. It also carries the English structure labels and IDs from the installed metadata; each gallery card exposes its labeled parts in a collapsed list. Thumbnail images were copied from the installed app's `modelsThumbnails` resources.

## Integrity check

The current local copy has metadata and a thumbnail for all 38 entries. The Blood, Blood-Air Barrier, and Synapse preview glTF files each reference existing vertex and index buffers with matching byte lengths and valid mesh/accessor references. No texture payloads are present, so none of the entries is a complete textured copy. The existing app-cache snapshot was also checked against the model manifests; it contains no additional detailed-model buffers matching the manifests' filenames or declared byte lengths. Further cache recovery will need a newer cache snapshot after the app has downloaded more assets.

Run `python3 tools/validate_detailed_models.py` from the repository root to repeat the catalog, thumbnail, manifest-buffer, preview, and completeness checks.
