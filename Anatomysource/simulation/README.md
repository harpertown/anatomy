# Cardiac electrophysiology prototype

This is an offline research pipeline alongside the Three.js viewer. It is not part of the browser build: FEniCSx solves on the workstation, and validated results can later be exported as activation/voltage fields for visualization.

## Toolchain

Create the environment with micromamba:

```sh
micromamba env create -f Anatomysource/simulation/environment.yml
micromamba run -n forme-ep python Anatomysource/simulation/scripts/fetch_reference_mesh.py
micromamba run -n forme-ep python Anatomysource/simulation/scripts/inspect_reference_mesh.py
micromamba run -n forme-ep python Anatomysource/simulation/scripts/prepare_reference_mesh.py
micromamba run -n forme-ep python Anatomysource/simulation/scripts/project_app_electrodes.py
micromamba run -n forme-ep python Anatomysource/simulation/scripts/verify_solver.py
```

Use `micromamba run -p ~/.local/share/forme-ep ...` if using the environment already created locally. The pinned package versions currently used are DOLFINx 0.10 and fenicsx-beat 0.6.4.

## Reference mesh and rights

The initial reference is the mechanical mesh from [Four-Chamber Human Heart Model for the Simulation of Cardiac Electrophysiology and Cardiac Mechanics](https://zenodo.org/records/10526554), by Roney et al. The mesh is MRI-derived and includes four chambers, labeled tissue regions, and cell-wise fiber, sheet, and sheet-normal directions. Cite the dataset paper and Zenodo record in any derived research output. The record uses CC BY-NC 4.0; keep downloaded data and derived meshes local unless the intended use is covered by that license. The original Complete Anatomy assets are not used as simulation ground truth.

Electrode locations are projected onto the app's own male/female integumentary model by `project_app_electrodes.py`: V1–V6 onto thorax skin, including the female breast skin patches; RA/LA onto upper chest skin directly over the paired Trapezoid Ligament meshes; and RL/LL onto lower-abdominal skin near the iliac crest. The Trapezoid Ligament centers come from each model's connective-tissue system, and RA/LA are projected to the nearest matching thorax skin surface. V1/V2 are placed slightly above the skeleton-derived midpoint of ribs 4 and 5 while remaining within the fourth intercostal space. The fifth intercostal reference is the midpoint between ribs 5 and 6. V4 is placed on the left midclavicular line at that level; V6 is placed on the lateral/midaxillary chest wall at V4's level. V5 is placed halfway along the horizontal skin path from V4 to V6, following the AHA/ACC/HRS option when the anterior axillary line is ambiguous. V3 remains the 3D coordinate midpoint between V2 and V4. The results are stored in `public/models/ecg-landmarks.json`, which the 3D viewer reads for its electrode markers. When ECG guides are enabled, the viewer lazily loads a translucent context from the corresponding torso and shoulder skin surfaces so those markers sit on the body; forearm and leg skin are excluded. If the integumentary model is already loaded, it uses that model. The script also exports the relevant source skin patches as `results/{male,female}-app-electrode-skin.vtm` for inspecting and developing the torso geometry. Those patches are not a closed volume mesh. Limb points are skeleton-guided search seeds projected to the nearest named skin surfaces; these are explicit model placements, not patient-specific measured electrode coordinates.

The 129k-cell mechanical mesh has approximately 3 mm mean edge length. It is suitable for an initial method and pipeline prototype, not fine conduction-system or clinical ECG claims. The same dataset includes a much finer EP mesh (about 50 million elements), which is too large for this workstation prototype. A robust 12-lead forward model will also need a torso volume/conductivity model, correct electrode coordinates, calibrated tissue conductivities, and validation against reference ECGs.

## What “accurate” requires

The current viewer conduction overlay is hand-authored path geometry and timing. It is useful as a visual explainer, but it is not an electrophysiology solution. The viewer currently has electrode guides but no ECG strip. `fenicsx-beat` can solve monodomain/bidomain tissue equations and recover a pseudo-ECG. The `ECGRecovery` approach in the pinned version assumes a homogeneous unbounded conductor; this is not equivalent to a torso-based 12-lead ECG. Do not present its traces as clinically accurate.

Pipeline stages:

1. Validate mesh topology, tissue labels, and fiber directions (`inspect_reference_mesh.py`).
2. Convert the mesh to XDMF with a sidecar retaining cell-wise tissue labels and fiber/sheet directions (`prepare_reference_mesh.py`). Cell ordering must be mapped by geometry when assigning the fields in DOLFINx.
3. Load the prepared mesh and fields in DOLFINx, then establish tissue conductivities, ionic models, and anatomically located stimuli.
4. Run spatial/temporal convergence and published electrophysiology verification cases (`verify_solver.py` is a small manufactured-solution temporal check).
5. Turn the app skin surface into a closed, labeled torso volume conductor and couple it to an aligned heart volume. The skin meshes are surface patches, so this step needs a documented watertight reconstruction and a checked heart-to-torso registration; their visual alignment alone is not a valid electrical coupling.
6. Derive the standard limb leads and chest leads from electrode potentials with `scripts/derive_twelve_leads.py`. It uses Einthoven's and Goldberger's definitions and the Wilson central terminal. RL is a ground/reference electrode, not one of the 12 leads.
7. Compare morphology, polarity, timing, and amplitude against published normal ECG benchmarks.
8. Export the simulated activation/voltage field and lead traces with a shared cycle clock for the viewer.

Passing a solver verification case validates numerical implementation for that case. It does not validate this anatomy, parameters, lead placement, or an individual patient's ECG.
