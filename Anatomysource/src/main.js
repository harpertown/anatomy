import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import './style.css';

function createGLTFLoader(manager) {
  const loader = new GLTFLoader(manager);
  loader.setMeshoptDecoder(MeshoptDecoder);
  return loader;
}

const el = (id) => document.getElementById(id);
const ui = {
  input: el('model-input'),
  library: el('model-library'),
  libraryLoad: el('load-library-models'),
  modelQuality: el('model-quality-switch'),
  emptyModelPicker: el('empty-model-picker'),
  emptyModelLoad: el('empty-load-model'),
  fps: el('viewport-fps'),
  modelLoadProgress: el('model-load-progress'),
  modelLoadLabel: el('model-load-label'),
  modelLoadPercent: el('model-load-percent'),
  modelLoadTrack: document.querySelector('.model-load-track'),
  modelLoadFill: el('model-load-fill'),
  tree: el('scene-tree'),
  treeEmpty: el('tree-empty'),
  search: el('structure-search'),
  nodeCount: el('node-count'),
  modelTitle: el('model-title'),
  selectedCrumb: el('selected-crumb'),
  status: el('status-message'),
  meshSummary: el('mesh-summary'),
  emptyState: el('empty-state'),
  hud: el('viewport-hud'),
  inspectorEmpty: el('inspector-empty'),
  inspectorContent: el('inspector-content'),
  selectedName: el('selected-name'),
  selectedType: el('selected-type-label'),
  selectedPath: el('selected-path'),
  geometry: el('property-geometry'),
  triangles: el('property-triangles'),
  materials: el('property-materials'),
  source: el('source-value'),
  isolate: el('isolate-selected'),
  toggle: el('toggle-selected'),
  toast: el('toast'),
  controlsMenuToggle: el('controls-menu-toggle'),
  controlsMenuLabel: el('controls-menu-label'),
  controlsMenu: el('controls-menu'),
  lowPowerMode: el('low-power-mode'),
  focusHeart: el('focus-heart'),
  animation: el('toggle-animation'),
  conduction: el('toggle-conduction'),
  depolarization: el('toggle-depolarization'),
  ecg: el('toggle-ecg'),
};

const canvas = el('viewport');
const LOW_POWER_MODE_STORAGE_KEY = 'forme-low-power-mode-v1';
const DEFAULT_RENDER_PIXEL_RATIO = 1.25;
const reportedMemoryGiB = Number(navigator.deviceMemory) || 0;
const reportedCpuCores = Number(navigator.hardwareConcurrency) || 0;
let lowPowerMode = (reportedMemoryGiB > 0 && reportedMemoryGiB <= 4)
  || (reportedCpuCores > 0 && reportedCpuCores <= 4);
try {
  const savedPowerPreference = localStorage.getItem(LOW_POWER_MODE_STORAGE_KEY);
  if (savedPowerPreference !== null) lowPowerMode = savedPowerPreference === 'true';
} catch { /* Keep the device-informed default when browser storage is unavailable. */ }
// No canvas export path uses the drawing buffer, so avoid forcing the GPU to preserve it.
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !lowPowerMode, alpha: true, preserveDrawingBuffer: false });
renderer.setPixelRatio(lowPowerMode ? Math.min(window.devicePixelRatio || 1, 1) : Math.min(window.devicePixelRatio || 1, DEFAULT_RENDER_PIXEL_RATIO));
renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.toneMappingExposure = 1;

let heartEnvironmentPromise;
let sourceIblPromise;
const SOURCE_IBL = '/models/environments/';
const SOURCE_RENDER_ESTIMATES = { exposure: 0.85, overlayVisibility: 0 };
const RENDER_TUNING_STORAGE_KEY = 'forme-heart-render-tuning-v2';
const sourceRenderTuning = { ...SOURCE_RENDER_ESTIMATES, iblIntensity: 1 };
try {
  Object.assign(sourceRenderTuning, JSON.parse(localStorage.getItem(RENDER_TUNING_STORAGE_KEY) || '{}'));
} catch { /* Keep the source-informed defaults if browser storage is unavailable. */ }
const sourceShaderUniforms = new Set();
const sourceShaderUniformsByMaterial = new WeakMap();

function updateRenderTuning(field, value) {
  sourceRenderTuning[field] = value;
  const uniformName = {
    exposure: 'formeSourceExposure',
    overlayVisibility: 'formeSourceOverlayVisibility',
    iblIntensity: 'formeSourceIblIntensity',
  }[field];
  for (const uniforms of sourceShaderUniforms) {
    if (uniforms[uniformName]) uniforms[uniformName].value = value;
  }
  try { localStorage.setItem(RENDER_TUNING_STORAGE_KEY, JSON.stringify(sourceRenderTuning)); } catch { /* The slider still applies for this session. */ }
}
for (const field of ['exposure', 'overlayVisibility', 'iblIntensity']) updateRenderTuning(field, sourceRenderTuning[field]);

async function loadSourceIbl() {
  if (!sourceIblPromise) {
    sourceIblPromise = (async () => {
      const loadBytes = async (name) => {
        const response = await fetch(`${SOURCE_IBL}${name}`);
        if (!response.ok) throw new Error(`Could not load source IBL payload ${name}`);
        return new Uint16Array(await response.arrayBuffer());
      };
      const [diffuseData, specularData, brdfData] = await Promise.all([
        loadBytes('cape_hill_diffuse_rgba16f.bin'),
        loadBytes('cape_hill_specular_rgba16f.bin'),
        loadBytes('cape_hill_brdf_rg16f.bin'),
      ]);
      const makeFaces = (data, size, channels, faceOffset = 0) => Array.from({ length: 6 }, (_, face) => {
        const length = size * size * channels;
        const start = faceOffset + face * length;
        const texture = new THREE.DataTexture(data.subarray(start, start + length), size, size, channels === 4 ? THREE.RGBAFormat : THREE.RGFormat, THREE.HalfFloatType);
        texture.magFilter = THREE.LinearFilter;
        texture.minFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;
        texture.colorSpace = THREE.NoColorSpace;
        texture.needsUpdate = true;
        return texture;
      });
      const diffuseFaces = makeFaces(diffuseData, 128, 4);
      const diffuse = new THREE.CubeTexture(diffuseFaces);
      diffuse.type = THREE.HalfFloatType;
      diffuse.format = THREE.RGBAFormat;
      diffuse.magFilter = THREE.LinearFilter;
      diffuse.minFilter = THREE.LinearFilter;
      diffuse.generateMipmaps = false;
      diffuse.colorSpace = THREE.NoColorSpace;
      diffuse.needsUpdate = true;

      const specularFaces = makeFaces(specularData, 512, 4);
      const specular = new THREE.CubeTexture(specularFaces);
      specular.type = THREE.HalfFloatType;
      specular.format = THREE.RGBAFormat;
      specular.magFilter = THREE.LinearFilter;
      specular.minFilter = THREE.LinearMipmapLinearFilter;
      specular.generateMipmaps = false;
      specular.colorSpace = THREE.NoColorSpace;
      let offset = 512 * 512 * 6 * 4;
      specular.mipmaps = [];
      // The shipped payload contains six levels total: 512px through 16px.
      // Roughness uses LOD 5 at most, so a 8px mip is neither present nor needed.
      for (const size of [256, 128, 64, 32, 16]) {
        const faces = makeFaces(specularData, size, 4, offset);
        specular.mipmaps.push({ image: faces, width: size, height: size });
        offset += size * size * 6 * 4;
      }
      if (offset !== specularData.length) throw new Error('Source specular mip chain length does not match its manifest.');
      specular.needsUpdate = true;

      const brdf = new THREE.DataTexture(brdfData, 256, 256, THREE.RGFormat, THREE.HalfFloatType);
      brdf.magFilter = THREE.LinearFilter;
      brdf.minFilter = THREE.LinearFilter;
      brdf.generateMipmaps = false;
      brdf.colorSpace = THREE.NoColorSpace;
      brdf.needsUpdate = true;
      return { diffuse, specular, brdf };
    })();
  }
  return sourceIblPromise;
}

function loadHeartEnvironment() {
  if (!heartEnvironmentPromise) {
    heartEnvironmentPromise = new HDRLoader().loadAsync('/models/environments/cape_hill.hdr').then((source) => {
      const generator = new THREE.PMREMGenerator(renderer);
      const target = generator.fromEquirectangular(source);
      source.dispose();
      generator.dispose();
      return target.texture;
    });
  }
  return heartEnvironmentPromise;
}

const scene = new THREE.Scene();
scene.background = new THREE.Color('#111d28');
const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 1000);
camera.position.set(2.9, 1.8, 3.6);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.075;
controls.enablePan = true;
controls.screenSpacePanning = true;
controls.minDistance = 0.12;
controls.maxDistance = 100;
controls.target.set(0, 0, 0);
const viewerBoundsSphere = new THREE.Sphere(new THREE.Vector3(), 1);

// Captured from the running app's LightsBuffer: three directional lights,
// white intensities 1.8 / 0.5 / 1.3, ambient RGB 0.4, identity IBL rotation.
const sourceDirectionalLights = [
  { direction: [-0.586517, 0.732959, 0.344628], intensity: 1.8 },
  { direction: [0.710924, 0.015361, 0.703101], intensity: 0.5 },
  { direction: [0.930026, -0.075524, -0.359650], intensity: 1.3 },
];
for (const { direction, intensity } of sourceDirectionalLights) {
  const light = new THREE.DirectionalLight(0xffffff, intensity);
  light.position.set(...direction);
  scene.add(light);
}
const grid = new THREE.GridHelper(4, 16, 0x344a58, 0x263945);
grid.position.y = -1.04;
grid.material.transparent = true;
grid.material.opacity = 0.44;
scene.add(grid);

let wasm;
let modelGroup = null;
let activeHeartRoot = null;
let activeHeartModelId = '';
let ecgTorsoContextPromise = null;
let ecgTorsoContextEligible = false;
const ecgSupportModelFetches = new Map();
const ecgTorsoFetches = new Map();
const ecgSupportModelBlobs = new Map();
const ecgTorsoBlobs = new Map();
const originalHeartTextureSizes = new Map();
let ecgSupportVisibility = null;
let loadedRoot = null;
let modelFileName = '';
let loadedModelFileBytes = 0;
let loadedTextureBytes = 0;
let allNodes = [];
let selectedNode = null;
let selectedLead = null;
let selectionBox = null;
let selectionHighlightSources = [];
let toastTimer = 0;
let nodeMap = new Map();
let libraryModels = [];
let selectedLibrarySex = 'Male';
const QUALITY_ORDER = ['low', 'medium', 'high', 'original'];
const LEGACY_HEART_QUALITY = { 'Heart Extreme Lite': 'low', 'Heart Super Lite': 'medium', 'Heart Lite': 'high', Heart: 'original' };
const selectedModelQuality = new Map([['Male', 'original'], ['Female', 'original']]);
function modelQuality(model) {
  return model?.quality || LEGACY_HEART_QUALITY[model?.system] || 'original';
}
function modelSystem(model) {
  return ['Heart', 'Heart Lite', 'Heart Super Lite', 'Heart Extreme Lite'].includes(model?.system) ? 'Heart' : model?.system;
}
function isHeartLibraryModel(model) {
  return modelSystem(model) === 'Heart';
}
function modelForQuality(sex, system, quality = selectedModelQuality.get(sex) || 'original') {
  return libraryModels.find((model) => model.model === sex && modelSystem(model) === system && modelQuality(model) === quality)
    || libraryModels.find((model) => model.model === sex && modelSystem(model) === system && modelQuality(model) === 'original');
}
function baseLibraryModels(sex = selectedLibrarySex) {
  return libraryModels.filter((model) => model.model === sex && modelQuality(model) === 'original');
}
function visibleLibraryModels(sex = selectedLibrarySex) {
  const quality = selectedModelQuality.get(sex) || 'original';
  return baseLibraryModels(sex).map((base) => modelForQuality(sex, modelSystem(base), quality) || base);
}
function syncModelSelectionForQuality(sex = selectedLibrarySex, quality = selectedModelQuality.get(sex) || 'original') {
  const selection = librarySelectionsBySex.get(sex);
  if (!selection) return;
  const selectedSystems = new Set([...selection]
    .map((id) => libraryModels.find((model) => model.id === id))
    .filter(Boolean)
    .map(modelSystem));
  if (!selectedSystems.size) return;
  for (const model of libraryModels) {
    if (model.model === sex && selectedSystems.has(modelSystem(model))) selection.delete(model.id);
  }
  for (const system of selectedSystems) {
    const model = modelForQuality(sex, system, quality);
    if (model) selection.add(model.id);
  }
}
function renderModelQualityControl() {
  if (!ui.modelQuality) return;
  const quality = selectedModelQuality.get(selectedLibrarySex) || 'original';
  for (const button of ui.modelQuality.querySelectorAll('[data-model-quality]')) {
    button.disabled = !QUALITY_ORDER.includes(button.dataset.modelQuality);
    button.setAttribute('aria-pressed', String(quality === button.dataset.modelQuality));
  }
}
function setModelQuality(quality) {
  if (!QUALITY_ORDER.includes(quality)) return;
  selectedModelQuality.set(selectedLibrarySex, quality);
  syncModelSelectionForQuality(selectedLibrarySex, quality);
  const emptySelection = emptyModelSelectionBySex.get(selectedLibrarySex);
  const emptyModel = libraryModels.find((model) => model.id === emptySelection);
  if (emptyModel) {
    const variant = modelForQuality(selectedLibrarySex, modelSystem(emptyModel), quality);
    if (variant) emptyModelSelectionBySex.set(selectedLibrarySex, variant.id);
  }
  renderModelQualityControl();
  renderLibrarySexOptions();
  renderEmptyModelOptions();
}
function isHeartModelId(modelId) {
  const model = libraryModels.find((entry) => entry.id === modelId);
  return model ? isHeartLibraryModel(model) : /-heart(?:-(?:(?:super|extreme)-)?lite)?(?:-(?:low|medium|high))?$/.test(modelId || '');
}
function isReducedHeartModelId(modelId) {
  const model = libraryModels.find((entry) => entry.id === modelId);
  return model ? isHeartLibraryModel(model) && modelQuality(model) !== 'original'
    : /-heart-(?:(?:super|extreme)-)?lite(?:-(?:low|medium|high))?$/.test(modelId || '');
}
function heartTextureVariant(modelId) {
  const model = libraryModels.find((entry) => entry.id === modelId);
  if (model) return modelQuality(model);
  if (/-heart-extreme-lite$/.test(modelId || '')) return 'low';
  if (/-heart-super-lite$/.test(modelId || '')) return 'medium';
  if (/-heart-lite$/.test(modelId || '')) return 'high';
  return 'original';
}
function compatibleLibraryModelAsset(model) {
  if (modelQuality(model) === 'original' || MeshoptDecoder.supported) return model;
  const fallback = libraryModels.find((entry) => entry.id === model.qualityBaseId)
    || libraryModels.find((entry) => entry.model === model.model
      && modelSystem(entry) === modelSystem(model) && modelQuality(entry) === 'original');
  return fallback ? { ...model, file: fallback.file, chunks: fallback.chunks, fileSizeBytes: fallback.fileSizeBytes } : model;
}
const librarySelectionsBySex = new Map([
  ['Male', new Set(['male-2024-heart'])],
  ['Female', new Set(['female-2024-heart'])],
]);
const emptyModelSelectionBySex = new Map([
  ['Male', 'male-2024-heart'],
  ['Female', 'female-2024-heart'],
]);
let loadedLibraryModels = [];
let collapsedGroups = new Set();
let mixer = null;
let activeAnimationRoot = null;
let animationAction = null;
let animationPlaying = false;
let conductionOverlay = null;
let ecgLeadOverlay = null;
let conductionLines = [];
let conductionNodes = [];
let conductionMorphFollowers = [];
let conductionMorphAnchors = [];
let conductionElapsed = 0;
let depolarizationShell = null;
let depolarizationMeshPairs = [];
let previousFrameTime = performance.now();
let previousRenderTime = 0;
let fpsWindowStart = 0;
let fpsWindowFrames = 0;
let renderRequest = 0;
const heartMaterials = new Map();
const originalHeartTextures = new Map();
let conductionNodeGeometryPromise;
let structureDescriptionsPromise;
let ecgLandmarksPromise;
const depolarizationResting = new THREE.Color('#167bd4');
const depolarizationActive = new THREE.Color('#ec253e');
const depolarizationFront = new THREE.Color('#ffe052');

function requestRender() {
  if (renderRequest || document.hidden) return;
  renderRequest = requestAnimationFrame(render);
}

function applyLowPowerMode() {
  renderer.setPixelRatio(lowPowerMode
    ? Math.min(window.devicePixelRatio || 1, 1)
    : Math.min(window.devicePixelRatio || 1, DEFAULT_RENDER_PIXEL_RATIO));
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width && height) renderer.setSize(width, height, false);
  ui.lowPowerMode.setAttribute('aria-pressed', String(lowPowerMode));
  ui.lowPowerMode.title = lowPowerMode
    ? 'Low power rendering is on; disable it for higher resolution'
    : 'Reduce rendering resolution for lower-power hardware';
  requestRender();
}
// Approximate adult cardiac activation timing for this educational map.
// Calibrate model units to an adult heart height instead of assuming the GLB's scale.
const REFERENCE_HEART_HEIGHT_METERS = 0.12;
const ECG_LABEL_RENDER_ORDER = 1000;
const ECG_LEAD_DETAILS = {
  I: {
    kind: 'Bipolar limb lead',
    sections: [
      ['What it measures', 'The voltage at the left arm electrode (LA) compared with the right arm electrode (RA): LA − RA.'],
      ['Electrical view', 'Its positive direction runs from the right arm toward the left arm. Lead I gives a leftward, generally lateral view of the heart’s electrical activity.'],
      ['How to read it', 'The trace is a projection of the heart’s combined electrical activity along this axis; it does not isolate one structure.'],
    ],
  },
  II: {
    kind: 'Bipolar limb lead',
    sections: [
      ['What it measures', 'The voltage at the left leg electrode (LL) compared with the right arm electrode (RA): LL − RA.'],
      ['Electrical view', 'Its positive direction points down and left toward LL, giving an inferior view of cardiac activity.'],
      ['How to read it', 'Lead II is commonly used to follow rhythm because atrial and ventricular activity often project clearly along this axis.'],
    ],
  },
  III: {
    kind: 'Bipolar limb lead',
    sections: [
      ['What it measures', 'The voltage at the left leg electrode (LL) compared with the left arm electrode (LA): LL − LA.'],
      ['Electrical view', 'Its positive direction runs from the left arm down toward the left leg, providing another inferior view.'],
      ['How to read it', 'Lead III records a directional projection of total cardiac activity; it complements leads I and II.'],
    ],
  },
  aVR: {
    kind: 'Augmented unipolar limb lead',
    sections: [
      ['What it measures', 'The right arm voltage compared with the average of the left arm and left leg: RA − (LA + LL) / 2.'],
      ['Electrical view', 'The positive viewpoint is toward the right shoulder. Normal depolarization often travels away from this viewpoint, so much of the QRS is commonly negative.'],
      ['How it is derived', 'The augmented reference is the average of the other two limb electrodes. The right leg electrode (RL) is ground and is not part of this equation.'],
    ],
  },
  aVL: {
    kind: 'Augmented unipolar limb lead',
    sections: [
      ['What it measures', 'The left arm voltage compared with the average of the right arm and left leg: LA − (RA + LL) / 2.'],
      ['Electrical view', 'The positive viewpoint is toward the left shoulder, giving a high-lateral view of cardiac activity.'],
      ['How it is derived', 'The augmented reference is the average of the other two limb electrodes. The right leg electrode (RL) is ground and is not part of this equation.'],
    ],
  },
  aVF: {
    kind: 'Augmented unipolar limb lead',
    sections: [
      ['What it measures', 'The left leg voltage compared with the average of the right arm and left arm: LL − (RA + LA) / 2.'],
      ['Electrical view', 'The positive viewpoint is from below the heart, giving an inferior view of cardiac activity.'],
      ['How it is derived', 'The augmented reference is the average of the other two limb electrodes. The right leg electrode (RL) is ground and is not part of this equation.'],
    ],
  },
  V1: {
    kind: 'Unipolar precordial lead',
    sections: [
      ['What it measures', 'The voltage at chest electrode V1 compared with the Wilson central terminal, the average of RA, LA, and LL.'],
      ['Electrical view', 'V1 views cardiac activity from the right anterior chest and is particularly useful for right-sided and septal projections.'],
      ['Placement landmark', 'Standard placement is the fourth intercostal space at the right sternal border.'],
    ],
  },
  V2: {
    kind: 'Unipolar precordial lead',
    sections: [
      ['What it measures', 'The voltage at chest electrode V2 compared with the Wilson central terminal, the average of RA, LA, and LL.'],
      ['Electrical view', 'V2 views cardiac activity from the left anterior chest, contributing a septal and anterior perspective.'],
      ['Placement landmark', 'Standard placement is the fourth intercostal space at the left sternal border.'],
    ],
  },
  V3: {
    kind: 'Unipolar precordial lead',
    sections: [
      ['What it measures', 'The voltage at chest electrode V3 compared with the Wilson central terminal, the average of RA, LA, and LL.'],
      ['Electrical view', 'V3 provides an anterior view between the more septal V2 and the anterior V4.'],
      ['Placement landmark', 'Standard placement is midway between V2 and V4.'],
    ],
  },
  V4: {
    kind: 'Unipolar precordial lead',
    sections: [
      ['What it measures', 'The voltage at chest electrode V4 compared with the Wilson central terminal, the average of RA, LA, and LL.'],
      ['Electrical view', 'V4 provides an anterior view near the cardiac apex.'],
      ['Placement landmark', 'Standard placement is the fifth intercostal space at the left midclavicular line.'],
    ],
  },
  V5: {
    kind: 'Unipolar precordial lead',
    sections: [
      ['What it measures', 'The voltage at chest electrode V5 compared with the Wilson central terminal, the average of RA, LA, and LL.'],
      ['Electrical view', 'V5 provides a left lateral view and is interpreted together with the other precordial leads.'],
      ['Placement landmark', 'Standard placement is level with V4 at the left anterior axillary line.'],
    ],
  },
  V6: {
    kind: 'Unipolar precordial lead',
    sections: [
      ['What it measures', 'The voltage at chest electrode V6 compared with the Wilson central terminal, the average of RA, LA, and LL.'],
      ['Electrical view', 'V6 provides the most lateral view of the standard precordial leads.'],
      ['Placement landmark', 'Standard placement is level with V4 and V5 at the left midaxillary line.'],
    ],
  },
  RA: {
    kind: 'Limb electrode',
    sections: [
      ['Role', 'The right arm electrode is an active measurement electrode in the bipolar and augmented limb leads.'],
      ['Used by', 'It is the negative pole for leads I and II, the positive viewpoint for aVR, and part of the Wilson central terminal used by V1–V6.'],
    ],
  },
  LA: {
    kind: 'Limb electrode',
    sections: [
      ['Role', 'The left arm electrode contributes to the limb-lead measurements.'],
      ['Used by', 'It is the positive pole for lead I, the negative pole for lead III, the positive viewpoint for aVL, and part of the references for the other augmented and precordial leads.'],
    ],
  },
  LL: {
    kind: 'Limb electrode',
    sections: [
      ['Role', 'The left leg electrode contributes to the limb-lead measurements.'],
      ['Used by', 'It is the positive pole for leads II and III, the positive viewpoint for aVF, and part of the references for the other augmented and precordial leads.'],
    ],
  },
  RL: {
    kind: 'Ground electrode',
    sections: [
      ['Role', 'The right leg electrode provides the ECG system ground and helps reduce common-mode electrical interference.'],
      ['Lead calculations', 'RL is not one of the ten signal electrodes used to calculate the standard 12 lead views.'],
    ],
  },
};
const MYOCARDIAL_PART_NAMES = /left atrium|left auricle|interventricular septum|fine apical trabeculations|wall of left ventricle|right atrium|right auricle|wall of right ventricle|coarse apical trabeculations|lateral wall of right atrium|posterolateral wall of left atrium|posterolateral wall of left ventricle|anterolateral wall of right ventricle|pectinate muscles/i;
const ATRIAL_BUNDLE_SPEED_M_S = 1.0;
const ATRIAL_MYOCARDIUM_SPEED_M_S = 0.4;
const AV_NODE_DELAY_SECONDS = 0.10;
const HIS_PURKINJE_SPEED_M_S = 2.0;
const PURKINJE_MUSCLE_DELAY_SECONDS = 0.005;
const VENTRICULAR_MYOCARDIUM_SPEED_M_S = 0.3;

async function loadConductionNodeGeometry(modelId) {
  if (!conductionNodeGeometryPromise) {
    conductionNodeGeometryPromise = fetch('/models/conduction-node-geometry.json').then((response) => {
      if (!response.ok) throw new Error('Cardiac node geometry is unavailable.');
      return response.json();
    });
  }
  const data = await conductionNodeGeometryPromise;
  const sexModel = modelId?.startsWith('female-2024') ? 'female-2024' : 'male-2024';
  return data.models?.[sexModel] || null;
}

async function loadECGLandmarks(modelId) {
  if (!ecgLandmarksPromise) {
    ecgLandmarksPromise = fetch('/models/ecg-landmarks.json').then((response) => {
      if (!response.ok) throw new Error('Chest ECG landmarks are unavailable.');
      return response.json();
    });
  }
  const data = await ecgLandmarksPromise;
  const sexModel = modelId?.startsWith('female-2024') ? 'female' : 'male';
  return data.models?.[sexModel] || null;
}

async function loadECGTorsoContext(modelId) {
  if (!isHeartModelId(modelId)) return null;
  const blob = await fetchECGTorsoBlob(modelId);
  const sexModel = modelId.startsWith('female-2024') ? 'female' : 'male';
  ecgTorsoBlobs.delete(`${sexModel}-2024-integumentary-system`);
  await MeshoptDecoder.ready;
  const gltf = await createGLTFLoader().parseAsync(await blob.arrayBuffer(), `${window.location.origin}/models/catalog/`);
  const sourceRoot = gltf.scene;
  sourceRoot.updateMatrixWorld(true);
  const context = new THREE.Group();
  context.name = 'ECG torso skin context';
  context.userData.excludeFromDepolarizationShell = true;
  const skinName = /^(Skin \((?:Thorax|Back|Abdomen|Neck|Shoulder|(?:Superior|Inferior) (?:Medial|Lateral) Quadrant of Breast);)/i;
  sourceRoot.traverse((object) => {
    if (!object.isMesh) return;
    const name = object.userData?.formeDisplayName || object.name || '';
    if (!skinName.test(name)) return;
    const geometry = object.geometry.clone();
    // Both app GLBs are authored in the same model coordinate space. Keep
    // this geometry in that local space; modelGroup applies the viewer fit.
    geometry.applyMatrix4(object.matrixWorld);
    const skin = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        color: '#a9c1c7',
        transparent: true,
        opacity: 0.13,
        side: THREE.DoubleSide,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    skin.name = `ECG placement context · ${name}`;
    skin.userData.excludeFromDepolarizationShell = true;
    skin.raycast = () => {};
    skin.renderOrder = 1;
    context.add(skin);
  });
  return context.children.length ? context : null;
}

async function fetchECGTorsoBlob(modelId) {
  const sexModel = modelId.startsWith('female-2024') ? 'female' : 'male';
  const key = `${sexModel}-2024-integumentary-system`;
  const cached = ecgTorsoBlobs.get(key);
  if (cached) {
    ecgTorsoBlobs.delete(key);
    return cached;
  }
  let pending = ecgTorsoFetches.get(key);
  if (!pending) {
    pending = fetch(`/models/catalog/${key}.glb`).then(async (response) => {
      if (!response.ok) throw new Error('The matching torso skin model is unavailable.');
      return response.blob();
    });
    ecgTorsoFetches.set(key, pending);
    pending.finally(() => {
      if (ecgTorsoFetches.get(key) === pending) ecgTorsoFetches.delete(key);
    }).catch(() => {});
  }
  return pending;
}

function getMyocardialBounds(root) {
  root.updateWorldMatrix(true, true);
  const rootFromWorld = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const meshToRoot = new THREE.Matrix4();
  const point = new THREE.Vector3();
  const bounds = new THREE.Box3().makeEmpty();
  root.traverse((object) => {
    if (!object.isMesh) return;
    let isMyocardium = false;
    for (let ancestor = object; ancestor && ancestor !== root; ancestor = ancestor.parent) {
      const name = ancestor.userData?.formeDisplayName || ancestor.name || '';
      if (MYOCARDIAL_PART_NAMES.test(name)) {
        isMyocardium = true;
        break;
      }
    }
    if (!isMyocardium) return;
    const position = object.geometry?.getAttribute('position');
    if (!position) return;
    meshToRoot.multiplyMatrices(rootFromWorld, object.matrixWorld);
    for (let i = 0; i < position.count; i += 1) {
      point.fromBufferAttribute(position, i).applyMatrix4(meshToRoot);
      bounds.expandByPoint(point);
    }
  });
  return bounds;
}

function getModelMetersPerUnit(root) {
  const height = getMyocardialBounds(root).getSize(new THREE.Vector3()).y;
  return height > 0 ? REFERENCE_HEART_HEIGHT_METERS / height : 0.02;
}

function createECGLeadOverlay(root, landmarks) {
  const bounds = getMyocardialBounds(root);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.78;
  const labelHeight = Math.max(size.y * 0.04, 0.07);
  const group = new THREE.Group();
  group.name = 'Model-registered ECG lead and electrode guides';
  group.userData.excludeFromDepolarizationShell = true;
  group.visible = false;
  const guideRadius = Math.max(labelHeight * 0.07, 0.012);
  const addGuide = (start, end, color, name) => {
    const delta = end.clone().sub(start);
    const guideLength = Math.max(delta.length(), 1e-6);
    const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.88, depthTest: false, depthWrite: false, toneMapped: false });
    // Fade the chest rays into the myocardial contact point so they read as
    // surface guides instead of hard lines drawn across the heart.
    material.onBeforeCompile = (shader) => {
      shader.uniforms.guideFadeLength = { value: guideLength };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float guideFadeLength;\nvarying float vGuideFade;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGuideFade = smoothstep(-guideFadeLength, -guideFadeLength * 0.58, position.y);');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vGuideFade;')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vGuideFade;');
    };
    material.customProgramCacheKey = () => 'ecg-chest-guide-surface-fade-v1';
    const guide = new THREE.Mesh(
      new THREE.CylinderGeometry(guideRadius, guideRadius, guideLength, 8),
      material,
    );
    // Anchor the cylinder at the electrode label: its local -Y end points
    // inward, so animation can change only its length without moving it.
    guide.geometry.translate(0, -guideLength * 0.5, 0);
    guide.position.copy(end);
    guide.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
    guide.name = name;
    guide.renderOrder = 8;
    group.add(guide);
    return { guide, baseLength: guideLength };
  };
  const label = (name, end, type, accent = '#82c9ca') => {
    const labelCanvas = document.createElement('canvas');
    labelCanvas.width = 192;
    labelCanvas.height = 96;
    const context = labelCanvas.getContext('2d');
    context.fillStyle = 'rgba(7,18,33,.97)';
    context.beginPath();
    context.roundRect(5, 5, 182, 86, 12);
    context.fill();
    context.strokeStyle = type === 'limb' ? accent : '#ffd071';
    context.lineWidth = 5;
    context.stroke();
    context.fillStyle = '#ffffff';
    context.font = '700 50px system-ui, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(name, 96, 48);
    const texture = new THREE.CanvasTexture(labelCanvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      // Lead labels are annotations, so keep them legible through anatomy,
      // electrode guides, and other transparent overlays.
      depthTest: false,
      depthFunc: THREE.LessEqualDepth,
      depthWrite: false,
      toneMapped: false,
    }));
    sprite.position.copy(end);
    sprite.scale.set(labelHeight * 6.6, labelHeight * 3.3, 1);
    sprite.renderOrder = ECG_LABEL_RENDER_ORDER;
    sprite.userData.ecgLeadName = name;
    group.add(sprite);
  };
  // Use skin-projected RA/LA sites over the trapezoid ligaments and lower-torso RL/LL sites.
  const limbElectrodes = [
    ['RA', -1, 1, '#ffca58'],
    ['LA', 1, 1, '#44e2cf'],
    ['RL', -1, -1, '#ff7484'],
    ['LL', 1, -1, '#bd9bff'],
  ];
  const limbPositions = {};
  for (const [name, xDirection, yDirection, color] of limbElectrodes) {
    const modelPosition = landmarks?.limbElectrodes?.[name];
    const end = modelPosition
      ? new THREE.Vector3(...modelPosition)
      : center.clone().add(new THREE.Vector3(xDirection * 0.72 * radius, yDirection * 0.72 * radius, 0));
    limbPositions[name] = end;
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(Math.max(labelHeight * 0.12, 0.012), 12, 8),
      new THREE.MeshBasicMaterial({ color, toneMapped: false, depthTest: true, depthWrite: false }),
    );
    marker.name = `Limb electrode ${name}`;
    marker.position.copy(end);
    marker.renderOrder = 10;
    group.add(marker);
    label(name, end, 'limb', color);
  }

  // Einthoven's triangle and the three augmented limb leads. Each segment is
  // anchored to the actual electrode markers; RL is only the recording ground.
  const midpoint = (a, b) => a.clone().add(b).multiplyScalar(0.5);
  const leadRadius = Math.max(labelHeight * 0.035, 0.006);
  const limbLead = (name, start, end, color, labelOffset = new THREE.Vector3()) => {
    const delta = end.clone().sub(start);
    const line = new THREE.Mesh(
      new THREE.CylinderGeometry(leadRadius, leadRadius, delta.length(), 8),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.94, depthTest: false, depthWrite: false, toneMapped: false }),
    );
    line.position.copy(start).add(end).multiplyScalar(0.5);
    line.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
    line.name = `Derived limb lead ${name}`;
    line.renderOrder = 8;
    group.add(line);

    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 72;
    const context = canvas.getContext('2d');
    context.fillStyle = 'rgba(7,18,33,.98)';
    context.beginPath();
    context.roundRect(4, 4, 120, 64, 12);
    context.fill();
    context.strokeStyle = color;
    context.lineWidth = 5;
    context.stroke();
    context.fillStyle = '#fff';
    context.font = '700 42px system-ui, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(name, 64, 36);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const leadLabel = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
    leadLabel.position.copy(start).add(end).multiplyScalar(0.5).add(labelOffset);
    leadLabel.scale.set(labelHeight * 6.6, labelHeight * 3.3, 1);
    leadLabel.renderOrder = ECG_LABEL_RENDER_ORDER;
    leadLabel.name = `Derived limb lead label ${name}`;
    leadLabel.userData.ecgLeadName = name;
    group.add(leadLabel);
  };
  if (limbPositions.RA && limbPositions.LA && limbPositions.LL) {
    const { RA, LA, LL } = limbPositions;
    limbLead('I', RA, LA, '#63d9d2', new THREE.Vector3(0, labelHeight * 0.24, 0));
    limbLead('II', RA, LL, '#ffd071', new THREE.Vector3(-labelHeight * 0.18, 0, 0));
    limbLead('III', LA, LL, '#a9a0ff', new THREE.Vector3(labelHeight * 0.18, 0, 0));
    limbLead('aVR', midpoint(LA, LL), RA, '#ff9b83', new THREE.Vector3(-labelHeight * 0.38, 0, 0));
    limbLead('aVL', midpoint(RA, LL), LA, '#7eb7ff', new THREE.Vector3(labelHeight * 0.38, 0, 0));
    limbLead('aVF', midpoint(RA, LA), LL, '#c3dc82', new THREE.Vector3(0, -labelHeight * 0.28, 0));
  }

  const rootInverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const meshToRoot = new THREE.Matrix4();
  const vertex = new THREE.Vector3();
  const myocardialPositions = [];
  const myocardialMeshes = [];
  root.traverse((object) => {
    if (!object.isMesh) return;
    let myocardial = false;
    for (let ancestor = object; ancestor && ancestor !== root; ancestor = ancestor.parent) {
      if (MYOCARDIAL_PART_NAMES.test(ancestor.userData?.formeDisplayName || ancestor.name || '')) {
        myocardial = true;
        break;
      }
    }
    if (!myocardial) return;
    myocardialMeshes.push(object);
    const position = object.geometry?.getAttribute('position');
    if (!position) return;
    meshToRoot.multiplyMatrices(rootInverse, object.matrixWorld);
    for (let i = 0; i < position.count; i += 1) {
      vertex.fromBufferAttribute(position, i).applyMatrix4(meshToRoot);
      myocardialPositions.push(vertex.x, vertex.y, vertex.z);
    }
  });
  const surfaceRaycaster = new THREE.Raycaster();
  function bindAnimatedSurfaceHit(hit) {
    if (!hit?.face || !hit.object.morphTargetInfluences?.length) return null;
    const mesh = hit.object;
    const meshToRoot = rootInverse.clone().multiply(mesh.matrixWorld);
    const indices = [hit.face.a, hit.face.b, hit.face.c];
    const position = mesh.geometry.getAttribute('position');
    const basePositions = new Float32Array(9);
    for (let vertexIndex = 0; vertexIndex < 3; vertexIndex += 1) {
      const index = indices[vertexIndex];
      basePositions[vertexIndex * 3] = position.getX(index);
      basePositions[vertexIndex * 3 + 1] = position.getY(index);
      basePositions[vertexIndex * 3 + 2] = position.getZ(index);
    }
    const morphAttributes = mesh.geometry.morphAttributes.position || [];
    const morphDeltas = morphAttributes.map((attribute) => {
      const deltas = new Float32Array(9);
      for (let vertexIndex = 0; vertexIndex < 3; vertexIndex += 1) {
        const index = indices[vertexIndex];
        const offset = vertexIndex * 3;
        const baseX = basePositions[offset];
        const baseY = basePositions[offset + 1];
        const baseZ = basePositions[offset + 2];
        deltas[offset] = mesh.geometry.morphTargetsRelative ? attribute.getX(index) : attribute.getX(index) - baseX;
        deltas[offset + 1] = mesh.geometry.morphTargetsRelative ? attribute.getY(index) : attribute.getY(index) - baseY;
        deltas[offset + 2] = mesh.geometry.morphTargetsRelative ? attribute.getZ(index) : attribute.getZ(index) - baseZ;
      }
      return deltas;
    });
    const binding = { mesh, meshToRoot, basePositions, morphDeltas };
    const a = getAnimatedTriangleVertex(binding, 0, new THREE.Vector3());
    const b = getAnimatedTriangleVertex(binding, 1, new THREE.Vector3());
    const c = getAnimatedTriangleVertex(binding, 2, new THREE.Vector3());
    const rootPoint = root.worldToLocal(hit.point.clone());
    const barycentric = new THREE.Triangle(a, b, c).getBarycoord(rootPoint, new THREE.Vector3());
    if (!barycentric || ![barycentric.x, barycentric.y, barycentric.z].every(Number.isFinite)) return null;
    return { ...binding, barycentric };
  }
  const animatedSurfaceGuides = [];
  const chestElectrodePoints = Object.fromEntries(
    Object.entries(landmarks?.chestElectrodes || {}).map(([name, point]) => {
      const position = new THREE.Vector3(...point);
      if (name === 'V1' || name === 'V2') position.y += labelHeight * 1.65;
      if (name === 'V6') position.y += labelHeight * 9.9;
      return [name, position];
    }),
  );
  if (chestElectrodePoints.V4 && chestElectrodePoints.V6 && chestElectrodePoints.V5) {
    chestElectrodePoints.V5 = chestElectrodePoints.V4.clone().lerp(chestElectrodePoints.V6, 0.5);
  }
  for (const [name, end] of Object.entries(chestElectrodePoints)) {
    let nearest = center;

    // Aim from the skin electrode toward the heart center and use the first
    // myocardial triangle hit, so every guide terminates on the heart surface.
    const worldOrigin = root.localToWorld(end.clone());
    const worldCenter = root.localToWorld(center.clone());
    const toCenter = worldCenter.sub(worldOrigin);
    surfaceRaycaster.set(worldOrigin, toCenter.clone().normalize());
    surfaceRaycaster.near = 0;
    surfaceRaycaster.far = toCenter.length();
    const surfaceHit = surfaceRaycaster.intersectObjects(myocardialMeshes, false)[0];
    if (surfaceHit) nearest = root.worldToLocal(surfaceHit.point.clone());

    let nearestDistance = Infinity;
    if (!surfaceHit) {
      for (let i = 0; i < myocardialPositions.length; i += 3) {
        const dx = end.x - myocardialPositions[i];
        const dy = end.y - myocardialPositions[i + 1];
        const dz = end.z - myocardialPositions[i + 2];
        const distance = dx * dx + dy * dy + dz * dz;
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = new THREE.Vector3(myocardialPositions[i], myocardialPositions[i + 1], myocardialPositions[i + 2]);
        }
      }
    }
    const guide = addGuide(nearest, end, 0xffd071, `Chest electrode guide ${name}`);
    guide.guide.userData.targetLength = guide.baseLength;
    const surfaceBinding = bindAnimatedSurfaceHit(surfaceHit);
    if (surfaceBinding) {
      animatedSurfaceGuides.push({
        ...guide,
        surfaceBinding,
        electrodePoint: end.clone(),
        inwardDirection: nearest.clone().sub(end).normalize(),
      });
    }
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(Math.max(labelHeight * 0.12, 0.012), 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xffdf9e, toneMapped: false, depthTest: true, depthWrite: false }),
    );
    marker.name = `Chest electrode ${name}`;
    marker.position.copy(end);
    marker.renderOrder = 9;
    group.add(marker);
    label(name, end, 'chest');
  }
  let lastGuideUpdateTime = 0;
  const guideVertexA = new THREE.Vector3();
  const guideVertexB = new THREE.Vector3();
  const guideVertexC = new THREE.Vector3();
  const guideSurfacePoint = new THREE.Vector3();
  const guideRay = new THREE.Ray();
  const guideRayHit = new THREE.Vector3();
  function getAnimatedTriangleVertex(binding, vertexIndex, target) {
    const offset = vertexIndex * 3;
    let x = binding.basePositions[offset];
    let y = binding.basePositions[offset + 1];
    let z = binding.basePositions[offset + 2];
    const weights = binding.mesh.morphTargetInfluences;
    for (let morphIndex = 0; morphIndex < binding.morphDeltas.length; morphIndex += 1) {
      const weight = weights[morphIndex] || 0;
      if (!weight) continue;
      const delta = binding.morphDeltas[morphIndex];
      x += delta[offset] * weight;
      y += delta[offset + 1] * weight;
      z += delta[offset + 2] * weight;
    }
    return target.set(x, y, z).applyMatrix4(binding.meshToRoot);
  }
  group.userData.updateAnimatedSurfaceGuides = (frameTime = performance.now()) => {
    // Each guide keeps the triangle hit when it was created. Rebuild only
    // that triangle from its cached morph deltas, then intersect the fixed
    // electrode ray with it. This follows the beat without scanning the
    // myocardial meshes or calling Mesh.getVertexPosition every frame.
    const deltaSeconds = lastGuideUpdateTime ? Math.min((frameTime - lastGuideUpdateTime) / 1000, 0.05) : 1 / 60;
    const blend = 1 - Math.exp(-deltaSeconds * 24);
    for (const { guide, baseLength, surfaceBinding, electrodePoint, inwardDirection } of animatedSurfaceGuides) {
      const { barycentric } = surfaceBinding;
      getAnimatedTriangleVertex(surfaceBinding, 0, guideVertexA);
      getAnimatedTriangleVertex(surfaceBinding, 1, guideVertexB);
      getAnimatedTriangleVertex(surfaceBinding, 2, guideVertexC);
      guideSurfacePoint.copy(guideVertexA).multiplyScalar(barycentric.x)
        .addScaledVector(guideVertexB, barycentric.y)
        .addScaledVector(guideVertexC, barycentric.z);
      const maxLength = baseLength * 1.35;
      const projectedLength = guideSurfacePoint.sub(electrodePoint).dot(inwardDirection);
      guideRay.origin.copy(electrodePoint);
      guideRay.direction.copy(inwardDirection);
      const surfaceHit = guideRay.intersectTriangle(guideVertexA, guideVertexB, guideVertexC, false, guideRayHit);
      const surfaceLength = surfaceHit
        ? surfaceHit.sub(electrodePoint).dot(inwardDirection)
        : projectedLength;
      guide.userData.targetLength = Math.max(Math.min(surfaceLength, maxLength), 1e-6);
      const currentLength = guide.scale.y * baseLength;
      guide.scale.y = THREE.MathUtils.lerp(currentLength, guide.userData.targetLength, blend) / baseLength;
    }
    lastGuideUpdateTime = frameTime;
  };
  return group;
}

function createConductionOverlay(root, nodeModel = null) {
  root.updateWorldMatrix(true, true);
  const metersPerUnit = getModelMetersPerUnit(root);
  const group = new THREE.Group();
  group.name = 'Schematic cardiac conduction overlay';
  group.userData.excludeFromDepolarizationShell = true;
  group.userData.needsStaticUpdate = true;
  group.visible = ui.conduction.getAttribute('aria-pressed') === 'true';
  const gold = new THREE.MeshBasicMaterial({ color: 0xffc66d, toneMapped: false, transparent: true, opacity: 0.94, side: THREE.DoubleSide, depthTest: false, depthWrite: false });
  const nodeMaterial = new THREE.MeshBasicMaterial({ color: 0xfff0bd, toneMapped: false, side: THREE.DoubleSide, depthTest: false, depthWrite: false });
  const saNode = new THREE.Vector3(...(nodeModel?.sinuatrial?.center || [-0.5853819, 7.405447, -0.1474612]));
  const avNode = new THREE.Vector3(...(nodeModel?.atrioventricular?.center || [-0.0929236, 6.4663327, 0.2815996]));
  const routeOffset = new THREE.Vector3(...(nodeModel?.routeOffset || [0, 0, 0]));
  // The electrical structures come from the nervous-system model, while the
  // beating heart is animated with morph targets. Bind nearby source vertices
  // once, then reuse their morph displacement to keep the conduction geometry
  // registered to the animated myocardium.
  const morphSources = [];
  const rootInverse = root.matrixWorld.clone().invert();
  const morphCellSize = 0.12;
  const morphGrid = new Map();
  const cellKey = (x, y, z) => `${x},${y},${z}`;
  const toCell = (point) => [
    Math.floor(point.x / morphCellSize),
    Math.floor(point.y / morphCellSize),
    Math.floor(point.z / morphCellSize),
  ];
  root.traverse((object) => {
    if (!object.isMesh || !object.morphTargetInfluences?.length) return;
    const position = object.geometry?.getAttribute('position');
    if (!position) return;
    const meshToRoot = rootInverse.clone().multiply(object.matrixWorld);
    const source = { object, meshToRoot };
    morphSources.push(source);
    const local = new THREE.Vector3();
    for (let index = 0; index < position.count; index += 1) {
      object.getVertexPosition(index, local);
      const point = local.clone().applyMatrix4(meshToRoot);
      const cell = toCell(point);
      const key = cellKey(...cell);
      if (!morphGrid.has(key)) morphGrid.set(key, []);
      morphGrid.get(key).push({ ...source, index, point });
    }
  });
  function bindMorphPoint(point) {
    if (!morphSources.length) return null;
    const cell = toCell(point);
    let best = null;
    let bestDistanceSq = 0.42 * 0.42;
    for (let radius = 0; radius <= 4; radius += 1) {
      for (let x = -radius; x <= radius; x += 1) {
        for (let y = -radius; y <= radius; y += 1) {
          for (let z = -radius; z <= radius; z += 1) {
            if (radius && Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) !== radius) continue;
            const candidates = morphGrid.get(cellKey(cell[0] + x, cell[1] + y, cell[2] + z));
            if (!candidates) continue;
            for (const candidate of candidates) {
              const distanceSq = point.distanceToSquared(candidate.point);
              if (distanceSq < bestDistanceSq) {
                bestDistanceSq = distanceSq;
                best = { ...candidate, referencePoint: candidate.point.clone() };
              }
            }
          }
        }
      }
    }
    return best;
  }
  function registerMorphAnchor(anchor) {
    anchor.basePoint = anchor.point.clone();
    anchor.binding = bindMorphPoint(anchor.basePoint);
    conductionMorphAnchors.push(anchor);
  }
  function registerMorphFollower(mesh, data) {
    const attribute = mesh.geometry.getAttribute('position');
    const basePositions = new Float32Array(attribute.array);
    const baseRootPoints = data.positions.map((point) => new THREE.Vector3(...point).add(routeOffset));
    const bindings = baseRootPoints.map((point) => bindMorphPoint(point));
    conductionMorphFollowers.push({ attribute, basePositions, baseRootPoints, bindings });
  }
  function morphDisplacement(binding, target = new THREE.Vector3()) {
    if (!binding) return target.set(0, 0, 0);
    binding.object.getVertexPosition(binding.index, target);
    target.applyMatrix4(binding.meshToRoot).sub(binding.referencePoint);
    return target;
  }
  const pathwaySpecs = [
    ['anteriorInternodal', false],
    ['middleInternodal', false],
    ['posteriorInternodal', false],
    ['hisBundle', false],
    ['rightBundle', false],
    ['leftBundle', false],
  ];
  const pathways = nodeModel?.pathways || {};
  function makeCenterline(data, upward) {
    const points = data.positions.map((point) => new THREE.Vector3(...point));
    const minY = Math.min(...points.map((point) => point.y));
    const maxY = Math.max(...points.map((point) => point.y));
    const samples = 28;
    const centers = [];
    let previous = null;
    for (let slice = 0; slice < samples; slice += 1) {
      const t = (slice + 0.5) / samples;
      const targetY = minY + t * (maxY - minY);
      const tolerance = Math.max((maxY - minY) / samples * 0.9, 0.012);
      const band = points.filter((point) => Math.abs(point.y - targetY) <= tolerance);
      if (band.length < 2) continue;
      const center = band.reduce((sum, point) => sum.add(point), new THREE.Vector3()).multiplyScalar(1 / band.length);
      // The band average can sit in empty space between Purkinje branches.
      // Snap to an actual source-mesh vertex, and favor the previous slice's
      // branch so the guide remains on one continuous fiber as it advances.
      const predicted = previous
        ? previous.clone().add(new THREE.Vector3(0, targetY - previous.y, 0))
        : center;
      let nearest = band[0];
      let nearestScore = Infinity;
      for (const candidate of band) {
        const continuity = candidate.distanceToSquared(predicted);
        const centerBias = candidate.distanceToSquared(center) * 0.12;
        const score = continuity + centerBias;
        if (score < nearestScore) {
          nearest = candidate;
          nearestScore = score;
        }
      }
      previous = nearest;
      centers.push(nearest.clone().add(routeOffset));
    }
    // Source slices are built from ventricular apex (low y) toward the base.
    // Atrial, His and bundle conduction runs toward the apex; Purkinje spread
    // then returns from the apex toward the ventricular walls/base.
    if (!upward) centers.reverse();
    return centers;
  }
  function addPathway(data, name, upward = false) {
    if (!data?.positions?.length || !data?.indices?.length) return;
    const center = new THREE.Vector3(...data.center).add(routeOffset);
    const relativePositions = data.positions.flatMap((point) => [point[0] - data.center[0], point[1] - data.center[1], point[2] - data.center[2]]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(relativePositions, 3));
    geometry.setIndex(data.indices);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, gold);
    mesh.name = name;
    mesh.userData.excludeFromDepolarizationShell = true;
    mesh.position.copy(center);
    mesh.renderOrder = 5;
    group.add(mesh);
    registerMorphFollower(mesh, data);
    const anchors = makeCenterline(data, upward).map((point) => ({ mesh: null, point }));
    anchors.forEach(registerMorphAnchor);
    if (anchors.length > 1) {
      const lineGeometry = new THREE.BufferGeometry();
      lineGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(anchors.length * 3), 3));
      const line = new THREE.Line(lineGeometry, gold);
      line.name = `${name} direction guide`;
      line.userData.excludeFromDepolarizationShell = true;
      line.renderOrder = 6;
      line.visible = false;
      // Morphing rewrites these few dozen anchor positions each frame; skip
      // rebuilding a bounding sphere for a line whose path follows the heart.
      line.frustumCulled = false;
      group.add(line);
      conductionLines.push({ line, anchors, updateAnchor: (anchor) => anchor.point });
    }
  }
  for (const [key, upward] of pathwaySpecs) {
    addPathway(pathways[key], {
      anteriorInternodal: 'Anterior Internodal Tract', middleInternodal: 'Middle Internodal Tract',
      posteriorInternodal: 'Posterior Internodal Tract', hisBundle: 'Atrioventricular Bundle (His)',
      rightBundle: 'Right Bundle Branch', leftBundle: 'Left Bundle Branch',
    }[key], upward);
  }
  (pathways.purkinje || []).forEach((data, branch) => {
    addPathway(data, `Purkinje Fibres · Subendocardial Branch ${branch + 1}`, true);
  });
  const updateAnchor = (anchor) => anchor.point;
  for (const [name, data, fallback] of [
    ['Sinuatrial Node', nodeModel?.sinuatrial, saNode],
    ['Atrioventricular Node', nodeModel?.atrioventricular, avNode],
  ]) {
    let geometry;
    if (data?.positions?.length && data?.indices?.length) {
      geometry = new THREE.BufferGeometry();
      const relativePositions = data.positions.flatMap((point) => [point[0] - data.center[0], point[1] - data.center[1], point[2] - data.center[2]]);
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(relativePositions, 3));
      geometry.setIndex(data.indices);
      geometry.computeVertexNormals();
    } else {
      geometry = new THREE.SphereGeometry(name === 'Sinuatrial Node' ? 0.09 : 0.075, 16, 12);
    }
    const node = new THREE.Mesh(geometry, nodeMaterial);
    node.name = name;
    node.userData.formeDisplayName = name;
    node.userData.anchor = { mesh: null, point: fallback.clone() };
    registerMorphAnchor(node.userData.anchor);
    node.position.copy(fallback);
    node.renderOrder = 7;
    group.add(node);
    conductionNodes.push({ node, updateAnchor });
  }
  group.userData.updateMorphFollowers = () => {
    const displacement = new THREE.Vector3();
    for (const follower of conductionMorphFollowers) {
      for (let i = 0; i < follower.bindings.length; i += 1) {
        const delta = morphDisplacement(follower.bindings[i], displacement);
        const offset = i * 3;
        follower.attribute.setXYZ(
          i,
          follower.basePositions[offset] + delta.x,
          follower.basePositions[offset + 1] + delta.y,
          follower.basePositions[offset + 2] + delta.z,
        );
      }
      follower.attribute.needsUpdate = true;
    }
    for (const anchor of conductionMorphAnchors) {
      anchor.point.copy(anchor.basePoint).add(morphDisplacement(anchor.binding, displacement));
    }
  };
  group.userData.updateAnchor = updateAnchor;
  root.add(group);
  return group;
}

async function ensureConductionOverlay() {
  if (conductionOverlay) return conductionOverlay;
  const heartRoot = activeHeartRoot;
  const heartModelId = activeHeartModelId;
  if (!heartRoot) return null;
  ui.conduction.disabled = true;
  try {
    let nodeModel = null;
    try { nodeModel = await loadConductionNodeGeometry(heartModelId); }
    catch (error) { console.warn('Using schematic conduction node markers.', error); }
    if (heartRoot !== activeHeartRoot) return null;
    conductionLines = [];
    conductionNodes = [];
    conductionMorphFollowers = [];
    conductionMorphAnchors = [];
    conductionOverlay = createConductionOverlay(heartRoot, nodeModel);
    return conductionOverlay;
  } finally {
    ui.conduction.disabled = !activeHeartRoot;
  }
}

function getConductionPathTiming(lines, metersPerUnit) {
  const lengths = lines.map(({ anchors }) => {
    let length = 0;
    for (let i = 0; i < anchors.length - 1; i += 1) length += anchors[i].point.distanceTo(anchors[i + 1].point);
    return length;
  });
  const starts = new Array(lengths.length).fill(0);
  const durations = new Array(lengths.length).fill(0);
  for (let i = 0; i < Math.min(3, lengths.length); i += 1) {
    durations[i] = lengths[i] * metersPerUnit / ATRIAL_BUNDLE_SPEED_M_S;
  }
  const avArrival = Math.max(...durations.slice(0, 3), 0);
  if (lengths.length > 3) {
    starts[3] = avArrival + AV_NODE_DELAY_SECONDS;
    durations[3] = lengths[3] * metersPerUnit / HIS_PURKINJE_SPEED_M_S;
  }
  const bundleStart = starts[3] + durations[3];
  for (let i = 4; i <= 5 && i < lengths.length; i += 1) {
    starts[i] = bundleStart;
    durations[i] = lengths[i] * metersPerUnit / HIS_PURKINJE_SPEED_M_S;
  }
  const bundleEnd = Math.max(bundleStart + (durations[4] || 0), bundleStart + (durations[5] || 0));
  for (let i = 6; i < lengths.length; i += 1) {
    starts[i] = bundleEnd;
    durations[i] = lengths[i] * metersPerUnit / HIS_PURKINJE_SPEED_M_S;
  }
  return { starts, durations };
}

function createDepolarizationMaterial(atrialTissue) {
  const uniforms = {
    uDepolarizationTime: { value: 0 },
    uCycleSeconds: { value: 1 },
    uPlateau: { value: atrialTissue ? 0.12 : 0.20 },
    uRecovery: { value: atrialTissue ? 0.06 : 0.08 },
    uRestingColor: { value: depolarizationResting.clone() },
    uActiveColor: { value: depolarizationActive.clone() },
    uFrontColor: { value: depolarizationFront.clone() },
  };
  const material = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.44,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  material.userData.depolarizationUniforms = uniforms;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float activationTime;\nvarying float vActivationTime;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvActivationTime = activationTime;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vActivationTime;\nuniform float uDepolarizationTime;\nuniform float uCycleSeconds;\nuniform float uPlateau;\nuniform float uRecovery;\nuniform vec3 uRestingColor;\nuniform vec3 uActiveColor;\nuniform vec3 uFrontColor;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        if (vActivationTime < 0.0) {
          diffuseColor.rgb = uRestingColor;
        } else {
          float elapsedSinceActivation = mod(uDepolarizationTime - vActivationTime, uCycleSeconds);
          if (elapsedSinceActivation < 0.0) elapsedSinceActivation += uCycleSeconds;
          float depolarized = 1.0 - smoothstep(uPlateau, uPlateau + uRecovery, elapsedSinceActivation);
          float wavefront = 1.0 - smoothstep(0.008, 0.020, elapsedSinceActivation);
          vec3 tissueColor = mix(uRestingColor, uActiveColor, depolarized * 0.86);
          diffuseColor.rgb = mix(tissueColor, uFrontColor, wavefront * 0.92);
        }`);
  };
  material.customProgramCacheKey = () => 'forme-depolarization-activation-time-v1';
  return { material, uniforms };
}

function createDepolarizationShell(root) {
  const shellRoot = root.clone(true);
  shellRoot.name = 'Depolarization wave shell';
  shellRoot.visible = false;
  const pairs = [];
  root.updateWorldMatrix(true, true);
  const localVertex = new THREE.Vector3();
  const metersPerUnit = getModelMetersPerUnit(root);
  const pathTiming = getConductionPathTiming(conductionLines, metersPerUnit);
  const { starts: pathStarts, durations: pathDurations } = pathTiming;
  const pathSegments = conductionLines.map(({ anchors }, pathIndex) => {
    const points = anchors.map((anchor) => anchor.point);
    const cumulative = [0];
    for (let i = 1; i < points.length; i += 1) {
      cumulative[i] = cumulative[i - 1] + points[i - 1].distanceTo(points[i]);
    }
    const totalLength = cumulative.at(-1) || 1;
    const segments = [];
    for (let i = 0; i < points.length - 1; i += 8) {
      const end = Math.min(i + 8, points.length - 1);
      const a = points[i];
      const b = points[end];
      segments.push({
        a,
        b,
        startTime: pathStarts[pathIndex] + pathDurations[pathIndex] * cumulative[i] / totalLength,
        endTime: pathStarts[pathIndex] + pathDurations[pathIndex] * cumulative[end] / totalLength,
      });
    }
    return { segments, pathIndex };
  });
  function activationAt(x, y, z, atrialTissue) {
    let arrival = Infinity;
    for (const { segments, pathIndex } of pathSegments) {
      if (atrialTissue ? pathIndex > 2 : pathIndex < 6) continue;
      const speed = atrialTissue ? ATRIAL_MYOCARDIUM_SPEED_M_S : VENTRICULAR_MYOCARDIUM_SPEED_M_S;
      for (const segment of segments) {
        const dx = segment.b.x - segment.a.x;
        const dy = segment.b.y - segment.a.y;
        const dz = segment.b.z - segment.a.z;
        const lengthSq = dx * dx + dy * dy + dz * dz || 1;
        const along = THREE.MathUtils.clamp(((x - segment.a.x) * dx + (y - segment.a.y) * dy + (z - segment.a.z) * dz) / lengthSq, 0, 1);
        const px = segment.a.x + dx * along;
        const py = segment.a.y + dy * along;
        const pz = segment.a.z + dz * along;
        const ox = x - px;
        const oy = y - py;
        const oz = z - pz;
        const distance = Math.sqrt(ox * ox + oy * oy + oz * oz);
        const pathArrival = THREE.MathUtils.lerp(segment.startTime, segment.endTime, along);
        const tissueArrival = pathArrival + (atrialTissue ? 0 : PURKINJE_MUSCLE_DELAY_SECONDS)
          + distance * metersPerUnit / speed;
        arrival = Math.min(arrival, tissueArrival);
      }
    }
    return Number.isFinite(arrival) ? arrival : Infinity;
  }
  function visit(source, clone, inheritedMyocardium = false) {
    if (source.userData?.excludeFromDepolarizationShell) {
      clone.visible = false;
      return;
    }
    const displayName = source.userData?.formeDisplayName || source.name || '';
    const isMyocardium = inheritedMyocardium || MYOCARDIAL_PART_NAMES.test(displayName);
    const selected = source.isMesh && isMyocardium;
    if (source.isMesh) {
      clone.visible = selected && source.visible;
      if (selected) {
        clone.geometry = source.geometry.clone();
        const position = clone.geometry.getAttribute('position');
        const activationTimes = new Float32Array(position.count);
        const rootCoordinates = new Float32Array(position.count * 3);
        const names = [];
        for (let node = source; node && node !== root; node = node.parent) {
          names.push(node.userData?.formeDisplayName || node.name || '');
        }
        const atrialTissue = /atrium|auricle|pectinate/i.test(names.join(' '));
        const meshToRoot = new THREE.Matrix4().copy(root.matrixWorld).invert().multiply(source.matrixWorld);
        for (let i = 0; i < position.count; i += 1) {
          localVertex.fromBufferAttribute(position, i).applyMatrix4(meshToRoot);
          const offset = i * 3;
          localVertex.toArray(rootCoordinates, offset);
        }
        clone.geometry.setAttribute('activationTime', new THREE.BufferAttribute(activationTimes, 1));
        const { material, uniforms } = createDepolarizationMaterial(atrialTissue);
        clone.material = material;
        clone.renderOrder = 4;
        clone.castShadow = false;
        clone.receiveShadow = false;
        pairs.push({ source, clone, selected, uniforms, rootCoordinates, atrialTissue });
      } else {
        pairs.push({ source, clone, selected });
      }
    } else {
      pairs.push({ source, clone, selected });
    }
    for (let i = 0; i < source.children.length; i += 1) visit(source.children[i], clone.children[i], isMyocardium);
  }
  visit(root, shellRoot);
  for (const pair of pairs) {
    if (!pair.selected) continue;
    const { clone, rootCoordinates, atrialTissue } = pair;
    const activationAttribute = clone.geometry.getAttribute('activationTime');
    const activationTimes = activationAttribute.array;
    for (let i = 0; i < activationTimes.length; i += 1) {
      const offset = i * 3;
      const arrival = activationAt(
        rootCoordinates[offset], rootCoordinates[offset + 1], rootCoordinates[offset + 2], atrialTissue,
      );
      activationTimes[i] = Number.isFinite(arrival) ? arrival : -1;
    }
    activationAttribute.needsUpdate = true;
    delete pair.rootCoordinates;
  }
  depolarizationMeshPairs = pairs;
  return shellRoot;
}

function updateConductionOverlay(delta) {
  if (!conductionOverlay?.visible && !depolarizationShell?.visible) return;
  const clockDrivenDepolarization = !animationAction && Boolean(depolarizationShell?.visible);
  const needsStaticUpdate = Boolean(
    conductionOverlay?.userData.needsStaticUpdate || depolarizationShell?.userData.needsStaticUpdate,
  );
  if (!animationPlaying && !clockDrivenDepolarization && !needsStaticUpdate) return;
  const updateHeartPose = animationPlaying || needsStaticUpdate;
  conductionElapsed += delta;
  const clipDuration = animationAction?.getClip().duration || 0;
  const cycleSeconds = clipDuration > 0
    ? clipDuration / Math.max(Math.abs(animationAction.timeScale), 0.001)
    : 1;
  const beatPhase = clipDuration > 0
    ? ((animationAction.time % clipDuration) + clipDuration) % clipDuration / clipDuration
    : (conductionElapsed % cycleSeconds) / cycleSeconds;
  if (updateHeartPose) {
    // Conduction anchors only read the animated heart. Updating the complete
    // scene graph here made a heart overlay walk thousands of unrelated body
    // meshes on every animation frame when multiple systems were loaded.
    activeHeartRoot?.updateWorldMatrix(true, true);
    conductionOverlay?.userData.updateMorphFollowers?.();
  }
  if (depolarizationShell?.visible) {
    const depolarizationTime = beatPhase * cycleSeconds;
    for (const { source, clone, selected, uniforms } of depolarizationMeshPairs) {
      if (updateHeartPose) {
        clone.position.copy(source.position);
        clone.quaternion.copy(source.quaternion);
        clone.scale.copy(source.scale);
        clone.visible = source.isMesh ? selected && source.visible : source.visible;
        if (source.morphTargetInfluences && clone.morphTargetInfluences) {
          for (let index = 0; index < source.morphTargetInfluences.length; index += 1) {
            clone.morphTargetInfluences[index] = source.morphTargetInfluences[index];
          }
        }
        clone.updateMatrix();
      }
      if (selected) {
        uniforms.uDepolarizationTime.value = depolarizationTime;
        uniforms.uCycleSeconds.value = cycleSeconds;
      }
    }
    if (updateHeartPose) depolarizationShell.updateWorldMatrix(true, true);
  }
  if (conductionOverlay?.visible && updateHeartPose) {
    for (const { line, anchors, updateAnchor } of conductionLines) {
      const positions = line.geometry.attributes.position;
      for (let i = 0; i < anchors.length; i += 1) {
        const point = updateAnchor(anchors[i]);
        positions.setXYZ(i, point.x, point.y, point.z);
      }
      positions.needsUpdate = true;
    }
    for (const { node, updateAnchor } of conductionNodes) node.position.copy(updateAnchor(node.userData.anchor));
  }
  if (conductionOverlay) conductionOverlay.userData.needsStaticUpdate = false;
  if (depolarizationShell) depolarizationShell.userData.needsStaticUpdate = false;
}

function showToast(message, kind = 'info') {
  ui.toast.textContent = message;
  ui.toast.dataset.kind = kind;
  ui.toast.classList.add('visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => ui.toast.classList.remove('visible'), 3400);
}

function setStatus(message) {
  ui.status.textContent = message;
}

function tissueTexture(baseHex, seed, kind) {
  const size = 256;
  const canvasTexture = document.createElement('canvas');
  canvasTexture.width = size;
  canvasTexture.height = size;
  const context = canvasTexture.getContext('2d');
  const pixels = context.createImageData(size, size);
  const color = new THREE.Color(baseHex).convertLinearToSRGB();
  const base = [color.r * 255, color.g * 255, color.b * 255];
  const hash = (x, y) => {
    const value = Math.sin((x + seed * 17.1) * 127.1 + (y + seed * 9.2) * 311.7) * 43758.5453;
    return value - Math.floor(value);
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fiber = Math.sin(y * 0.18 + Math.sin(x * 0.035 + seed) * 2.4) * 0.075;
      const grain = (hash(x, y) - 0.5) * (kind === 'height' ? 0.13 : 0.18);
      const variation = kind === 'height' ? 0.5 + fiber + grain : 0.91 + fiber + grain;
      const index = (y * size + x) * 4;
      if (kind === 'height') {
        const height = Math.round(128 + (fiber + grain) * 170);
        pixels.data[index] = height;
        pixels.data[index + 1] = height;
        pixels.data[index + 2] = height;
      } else if (kind === 'roughness') {
        const rough = Math.round(180 + fiber * 130 + grain * 110);
        pixels.data[index] = rough;
        pixels.data[index + 1] = rough;
        pixels.data[index + 2] = rough;
      } else {
        pixels.data[index] = Math.max(0, Math.min(255, base[0] * variation));
        pixels.data[index + 1] = Math.max(0, Math.min(255, base[1] * variation));
        pixels.data[index + 2] = Math.max(0, Math.min(255, base[2] * variation));
      }
      pixels.data[index + 3] = 255;
    }
  }
  context.putImageData(pixels, 0, 0);
  const texture = new THREE.CanvasTexture(canvasTexture);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2, 2);
  texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  texture.colorSpace = kind === 'albedo' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function getHeartMaterial(kind) {
  if (heartMaterials.has(kind)) return heartMaterials.get(kind);
  const palette = {
    myocardium: '#a64e58',
    artery: '#b34b48',
    vein: '#5b7094',
    valve: '#d5aa9b',
    fibrous: '#c8b99e',
    window: '#a96069',
  };
  const color = palette[kind] || palette.myocardium;
  const material = new THREE.MeshStandardMaterial({
    map: tissueTexture(color, kind.length, 'albedo'),
    roughnessMap: tissueTexture(color, kind.length + 1, 'roughness'),
    bumpMap: tissueTexture(color, kind.length + 2, 'height'),
    bumpScale: 0.012,
    roughness: kind === 'valve' ? 0.58 : 0.72,
    metalness: 0,
    side: THREE.DoubleSide,
    transparent: kind === 'window',
    opacity: kind === 'window' ? 0.58 : 1,
    depthWrite: kind !== 'window',
  });
  material.name = `Forme ${kind} tissue`;
  heartMaterials.set(kind, material);
  return material;
}

async function originalHeartTexture(filename, colorSpace) {
  const key = `${filename}:${colorSpace}`;
  if (!originalHeartTextures.has(key)) {
    originalHeartTextures.set(key, (async () => {
      const response = await fetch(`/models/textures/${encodeURIComponent(filename)}`);
      if (!response.ok) throw new Error(`Could not load heart texture ${filename}.`);
      const blob = await response.blob();
      originalHeartTextureSizes.set(filename, blob.size);
      const objectUrl = URL.createObjectURL(blob);
      let texture;
      try {
        texture = await new THREE.TextureLoader().loadAsync(objectUrl);
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
      texture.colorSpace = colorSpace;
      texture.flipY = false;
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      texture.needsUpdate = true;
      return texture;
    })());
  }
  return originalHeartTextures.get(key);
}

function heartTextureFilename(filename, variant) {
  if (!filename) return filename;
  return variant === 'original' ? filename : `${variant}-${filename.replace(/\.[^.]+$/, '')}.webp`;
}

function getAppliedTextureBytes(root, { heart = false, textureVariant = 'original' } = {}) {
  const filenames = new Set();
  root.traverse((object) => {
    if (!object.isMesh && !object.isSkinnedMesh && !object.isInstancedMesh) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      const albedoName = material?.userData?.formeOriginalAlbedoTexture;
      const normalName = material?.userData?.formeOriginalNormalTexture;
      if (heart && !albedoName) continue;
      if (albedoName) filenames.add(heartTextureFilename(albedoName, textureVariant));
      if (normalName) filenames.add(heartTextureFilename(normalName, textureVariant));
    }
  });
  if (heart) filenames.add(heartTextureFilename('filling_heart.png', textureVariant));
  return [...filenames].reduce((total, filename) => total + (originalHeartTextureSizes.get(filename) || 0), 0);
}

async function applySourceMaterials(root, { heart = false, textureVariant = 'original' } = {}) {
  const sourceProgramKey = heart ? 'forme-source-pbr-v2-heart' : 'forme-source-pbr-v2';
  const fillingTexture = heart
    ? await originalHeartTexture(heartTextureFilename('filling_heart.png', textureVariant), THREE.SRGBColorSpace)
    : null;
  let heartEnvironment;
  try {
    heartEnvironment = await loadSourceIbl();
  } catch (error) {
    console.warn('Could not load the original IBL payloads; falling back to Three.js PMREM.', error);
    try { heartEnvironment = await loadHeartEnvironment(); } catch (fallbackError) {
      console.warn('Could not load the source reflection environment; using direct lights only.', fallbackError);
    }
  }
  const replacements = [];
  const originals = new Set();
  const replacementByMaterial = new WeakMap();
  root.traverse((object) => {
    if (!object.isMesh) return;
    const label = `${object.userData?.formeClusterPath || ''} / ${object.userData?.formeDisplayName || object.name || ''}`.toLocaleLowerCase();
    let kind = 'myocardium';
    if (label.includes('major veins')) kind = 'vein';
    else if (label.includes('major arteries')) kind = 'artery';
    else if (label.includes('valves')) kind = 'valve';
    else if (label.includes('fibrous skeleton')) kind = 'fibrous';
    else if (label.includes('heart wall windows')) kind = 'window';
    const previous = Array.isArray(object.material) ? object.material : [object.material];
    const next = previous.map((material) => {
      if (!material) return heart ? getHeartMaterial(kind) : material;
      const originalAlbedoName = material.userData?.formeOriginalAlbedoTexture;
      const originalNormalName = material.userData?.formeOriginalNormalTexture;
      const albedoName = heartTextureFilename(originalAlbedoName, textureVariant);
      const normalName = heartTextureFilename(originalNormalName, textureVariant);
      if (heart && !originalAlbedoName) return getHeartMaterial(kind);
      if (!heart && !albedoName && !normalName && material.userData?.formeOriginalReflection === undefined) return material;
      let replacement = replacementByMaterial.get(material);
      if (!replacement) {
        originals.add(material);
        let activeMaterial = null;
        replacement = (async () => {
        const clone = material.clone();
        clone.opacity = material.userData?.formeOriginalOpacity ?? clone.opacity;
        if (albedoName) clone.map = await originalHeartTexture(albedoName, THREE.SRGBColorSpace);
        const sourceIbl = heartEnvironment?.specular ? heartEnvironment : null;
        clone.envMap = sourceIbl ? null : heartEnvironment || null;
        if (normalName) {
          clone.normalMap = await originalHeartTexture(normalName, THREE.NoColorSpace);
          const runtimeIntensity = material.userData?.formeRuntimeNormalIntensity;
          if (Array.isArray(runtimeIntensity) && runtimeIntensity.length === 2) {
            clone.normalScale.set(runtimeIntensity[0], runtimeIntensity[1]);
          } else {
            const normalScale = material.userData?.formeOriginalNormalScale ?? 1;
            clone.normalScale.set(normalScale, normalScale);
          }
        }
        const sourceReflection = material.userData?.formeOriginalReflection ?? 0.55;
        clone.envMapIntensity = sourceIbl ? 0 : 1;
        clone.side = THREE.DoubleSide;
        const sourceTone = (shader) => {
          shader.uniforms.formeHeartFillingMap = { value: fillingTexture };
          shader.uniforms.formeSourceOverlayVisibility = { value: heart ? sourceRenderTuning.overlayVisibility : 0 };
          shader.uniforms.formeSourceExposure = { value: sourceRenderTuning.exposure };
          shader.uniforms.formeSourceDiffuseIbl = { value: sourceIbl?.diffuse || null };
          shader.uniforms.formeSourceSpecularIbl = { value: sourceIbl?.specular || null };
          shader.uniforms.formeSourceBrdfLut = { value: sourceIbl?.brdf || null };
          shader.uniforms.formeSourceReflectance = { value: sourceReflection };
          shader.uniforms.formeSourceIblEnabled = { value: sourceIbl ? 1 : 0 };
          shader.uniforms.formeSourceIblIntensity = { value: sourceRenderTuning.iblIntensity };
          shader.uniforms.formeSourceDirectionalLights = {
            value: sourceDirectionalLights.map(({ direction, intensity }) => new THREE.Vector4(...direction, intensity)),
          };
          sourceShaderUniforms.add(shader.uniforms);
          if (activeMaterial) {
            let materialUniforms = sourceShaderUniformsByMaterial.get(activeMaterial);
            if (!materialUniforms) sourceShaderUniformsByMaterial.set(activeMaterial, materialUniforms = new Set());
            materialUniforms.add(shader.uniforms);
          }
          const mapFragment = heart
            ? `#include <map_fragment>
               vec4 formeHeartFillingTexel = texture2D(formeHeartFillingMap, vMapUv);
               diffuseColor.rgb = mix(diffuseColor.rgb, formeHeartFillingTexel.rgb, formeSourceOverlayVisibility * formeHeartFillingTexel.a);`
            : '#include <map_fragment>';
          shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', mapFragment);
          shader.fragmentShader = shader.fragmentShader.replace(
            'void main() {',
            `uniform sampler2D formeHeartFillingMap;
             uniform float formeSourceOverlayVisibility;
             uniform float formeSourceExposure;
             uniform samplerCube formeSourceDiffuseIbl;
             uniform samplerCube formeSourceSpecularIbl;
             uniform sampler2D formeSourceBrdfLut;
             uniform float formeSourceReflectance;
             uniform float formeSourceIblEnabled;
             uniform float formeSourceIblIntensity;
             uniform vec4 formeSourceDirectionalLights[3];
             void main() {`,
          );
          shader.fragmentShader = shader.fragmentShader.replace(
            '#include <lights_fragment_begin>',
            `#include <lights_fragment_begin>
             // Replace Three.js direct lighting with Complete Anatomy’s shipped GGX BRDF.
             reflectedLight.directDiffuse = vec3(0.0);
             reflectedLight.directSpecular = vec3(0.0);
             vec3 formeDirectN = normalize(transformDirectionByInverseViewMatrix(normal, viewMatrix));
             vec3 formeDirectV = normalize(transformDirectionByInverseViewMatrix(geometryViewDir, viewMatrix));
             float formeDirectNoV = clamp(dot(formeDirectN, formeDirectV), 0.0, 1.0);
             float formeDirectRoughness = clamp(roughnessFactor, 0.045, 1.0);
             float formeDirectAlpha = formeDirectRoughness * formeDirectRoughness;
             float formeDirectAlphaSquared = formeDirectAlpha * formeDirectAlpha;
             vec3 formeDirectF0 = vec3(0.16 * formeSourceReflectance * formeSourceReflectance * (1.0 - metalnessFactor)) + diffuseColor.rgb * metalnessFactor;
             vec3 formeDirectDiffuse = vec3(0.0);
             vec3 formeDirectSpecular = vec3(0.0);
             for (int formeLightIndex = 0; formeLightIndex < 3; formeLightIndex++) {
               vec4 formeLight = formeSourceDirectionalLights[formeLightIndex];
               vec3 formeDirectL = normalize(formeLight.xyz);
               float formeDirectNoL = clamp(dot(formeDirectN, formeDirectL), 0.0, 1.0);
               if (formeDirectNoL > 0.0) {
                 vec3 formeDirectH = normalize(formeDirectL + formeDirectV);
                 float formeDirectNoH = clamp(dot(formeDirectN, formeDirectH), 0.0, 1.0);
                 float formeDirectLoH = clamp(dot(formeDirectL, formeDirectH), 0.0, 1.0);
                 vec3 formeDirectF = formeDirectF0 + (vec3(1.0) - formeDirectF0) * pow(1.0 - formeDirectLoH, 5.0);
                 float formeDirectDenom = formeDirectNoH * formeDirectNoH * (formeDirectAlphaSquared - 1.0) + 1.0;
                 float formeDirectD = formeDirectAlphaSquared / (formeDirectDenom * formeDirectDenom * 3.141592653589793);
                 float formeDirectNoLSquared = formeDirectNoL * formeDirectNoL;
                 float formeDirectNoVSquared = formeDirectNoV * formeDirectNoV;
                 float formeDirectLambdaL = formeDirectNoV * sqrt(formeDirectNoLSquared + formeDirectAlphaSquared * (1.0 - formeDirectNoLSquared));
                 float formeDirectLambdaV = formeDirectNoL * sqrt(formeDirectNoVSquared + formeDirectAlphaSquared * (1.0 - formeDirectNoVSquared));
                 float formeDirectVis = 0.5 / (formeDirectLambdaL + formeDirectLambdaV + 0.001);
                 vec3 formeDirectLightColor = vec3(formeLight.w * formeDirectNoL);
                 formeDirectDiffuse += (vec3(1.0) - formeDirectF) * formeDirectLightColor;
                 formeDirectSpecular += formeDirectD * formeDirectVis * formeDirectF * formeDirectLightColor;
               }
             }
             vec3 formeDirectAlbedo = diffuseColor.rgb * (1.0 - metalnessFactor) / 3.141592653589793;
             reflectedLight.directDiffuse = formeDirectDiffuse * formeDirectAlbedo;
             reflectedLight.directSpecular = formeDirectSpecular;`,
          );
          shader.fragmentShader = shader.fragmentShader.replace(
            '#include <opaque_fragment>',
            `if (formeSourceIblEnabled > 0.5) {
               vec3 formeN = normalize(transformNormalByInverseViewMatrix(normal, viewMatrix));
               vec3 formeV = normalize(transformDirectionByInverseViewMatrix(geometryViewDir, viewMatrix));
               float formeNoV = clamp(dot(formeN, formeV), 0.0, 1.0);
               float formeRoughness = clamp(material.roughness, 0.045, 1.0);
               vec3 formeF0 = vec3(0.16 * formeSourceReflectance * formeSourceReflectance);
               vec3 formeF = formeF0 + (max(vec3(1.0 - formeRoughness), formeF0) - formeF0) * pow(1.0 - formeNoV, 5.0);
               vec3 formeAlbedo = diffuseColor.rgb * (1.0 - material.metalness) / 3.141592653589793;
               vec3 formeDiffuse = (vec3(1.0) - formeF) * texture(formeSourceDiffuseIbl, -formeN).rgb * formeAlbedo;
               vec3 formeReflect = reflect(formeV, formeN);
               vec3 formePrefiltered = textureLod(formeSourceSpecularIbl, formeReflect, 5.0 * formeRoughness).rgb;
               vec2 formeBrdf = texture(formeSourceBrdfLut, vec2(formeNoV, formeRoughness)).rg;
               outgoingLight += formeSourceIblIntensity * (formeDiffuse + formePrefiltered * (formeF * formeBrdf.x + formeBrdf.y));
             }
             #include <opaque_fragment>`,
          );
          shader.fragmentShader = shader.fragmentShader.replace(
            '#include <tonemapping_fragment>',
            'gl_FragColor.rgb = vec3(1.0) - exp(-gl_FragColor.rgb * formeSourceExposure);',
          );
        };
        clone.onBeforeCompile = sourceTone;
        clone.customProgramCacheKey = () => sourceProgramKey;
        const physicalSource = Object.assign({}, clone, {
          clearcoatNormalScale: new THREE.Vector2(1, 1),
          sheenColor: new THREE.Color(),
          attenuationColor: new THREE.Color(1, 1, 1),
          specularColor: new THREE.Color(1, 1, 1),
        });
        const glossy = new THREE.MeshPhysicalMaterial().copy(physicalSource);
        activeMaterial = glossy;
        // Source shader derives dielectric F0 as 0.16 * reflectance^2.
        const f0 = 0.16 * sourceReflection * sourceReflection;
        const rootF0 = Math.sqrt(Math.max(0, Math.min(0.99, f0)));
        glossy.ior = (1 + rootF0) / (1 - rootF0);
        glossy.clearcoat = 0;
        glossy.roughness = material.roughness ?? 0.1;
        glossy.onBeforeCompile = sourceTone;
        glossy.customProgramCacheKey = () => sourceProgramKey;
        glossy.needsUpdate = true;
        clone.dispose();
        return glossy;
        })();
        replacementByMaterial.set(material, replacement);
      }
      return replacement;
    });
    replacements.push(Promise.all(next).then((materials) => {
      object.material = Array.isArray(object.material) ? materials : materials[0];
    }));
  });
  await Promise.all(replacements);
  originals.forEach((material) => material.dispose());
}

function applyDetailedPreviewMaterials(root) {
  const replacements = new Map();
  root.traverse((object) => {
    if (!object.isMesh) return;
    const sources = Array.isArray(object.material) ? object.material : [object.material];
    const materials = sources.map((source) => {
      if (!source) return source;
      let replacement = replacements.get(source);
      if (!replacement) {
        // Detailed-model atlases can encode layer coverage in alpha that makes
        // otherwise valid gallery surfaces disappear under glTF BLEND rules.
        // Keep the recovered color atlas and show the complete authored mesh.
        replacement = new THREE.MeshBasicMaterial({
          map: source.map || null,
          color: source.color || new THREE.Color('#ffffff'),
          vertexColors: source.vertexColors,
          side: THREE.DoubleSide,
          transparent: false,
          opacity: 1,
          depthWrite: true,
        });
        replacement.name = source.name;
        replacements.set(source, replacement);
      }
      return replacement;
    });
    object.material = Array.isArray(object.material) ? materials : materials[0];
  });
  replacements.forEach((replacement, source) => { if (source !== replacement) source.dispose(); });
}

function releaseSourceShaderUniforms(root) {
  root.traverse((object) => {
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach((material) => {
      const uniforms = material && sourceShaderUniformsByMaterial.get(material);
      if (!uniforms) return;
      uniforms.forEach((entry) => sourceShaderUniforms.delete(entry));
      sourceShaderUniformsByMaterial.delete(material);
    });
  });
}

function updateAnimationButton() {
  if (!ui.animation) return;
  const label = animationPlaying ? 'Pause beat' : 'Play beat';
  const title = animationPlaying ? 'Pause the heart cycle' : 'Play the heart cycle';
  ui.animation.title = title;
  ui.animation.setAttribute('aria-label', title);
  ui.animation.innerHTML = animationPlaying
    ? '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM15 5h4v14h-4z"/></svg><span>Pause beat</span>'
    : '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg><span>Play beat</span>';
  ui.animation.classList.toggle('active', animationPlaying);
}

async function initWasm() {
  const response = await fetch('/mesh-core.wasm');
  if (!response.ok) throw new Error('The WebAssembly geometry core has not been built yet. Run npm run build.');
  const result = await WebAssembly.instantiateStreaming(response, {});
  return result.instance.exports;
}

function fitBounds(bounds) {
  const ptr = wasm.compute_fit(
    bounds.min.x, bounds.min.y, bounds.min.z,
    bounds.max.x, bounds.max.y, bounds.max.z,
  );
  const fit = new Float32Array(wasm.memory.buffer, ptr, 7);
  return {
    center: new THREE.Vector3(fit[0], fit[1], fit[2]),
    scale: fit[3],
    extents: new THREE.Vector3(fit[4], fit[5], fit[6]),
  };
}

function collectNodes(root) {
  const entries = [];
  root.traverse((object) => {
    if (object === root) return;
    const isMesh = object.isMesh || object.isSkinnedMesh || object.isInstancedMesh;
    const hasChildren = object.children.length > 0;
    if (!isMesh && !hasChildren && !object.name) return;
    const name = object.userData?.formeDisplayName?.trim() || object.name?.trim() || (isMesh ? `Unnamed ${object.type}` : object.type);
    const parentName = object.parent?.userData?.formeDisplayName?.trim() || object.parent?.name?.trim();
    const duplicateWrapper = !isMesh && object.parent !== root && parentName === name;
    if (duplicateWrapper) return;
    let depth = 0;
    for (let node = object.parent; node && node !== root; node = node.parent) {
      const nodeName = node.userData?.formeDisplayName?.trim() || node.name?.trim();
      const nodeParentName = node.parent?.userData?.formeDisplayName?.trim() || node.parent?.name?.trim();
      const nodeIsMesh = node.isMesh || node.isSkinnedMesh || node.isInstancedMesh;
      if (!(nodeName && nodeName === nodeParentName && !nodeIsMesh && node.parent !== root)) depth++;
    }
    const ancestors = [];
    for (let parent = object.parent; parent && parent !== root; parent = parent.parent) {
      const parentName = parent.userData?.formeDisplayName?.trim() || parent.name?.trim();
      const grandparentName = parent.parent?.userData?.formeDisplayName?.trim() || parent.parent?.name?.trim();
      const parentIsMesh = parent.isMesh || parent.isSkinnedMesh || parent.isInstancedMesh;
      const duplicateParent = !parentIsMesh && parent.parent !== root && parentName === grandparentName;
      if (parentName && !duplicateParent) ancestors.unshift(parentName);
    }
    entries.push({ object, id: object.id, name, depth, path: [...ancestors, name].join(' / '), isMesh });
  });
  return entries;
}

function countMeshFacts(object) {
  let meshes = 0;
  let triangles = 0;
  let materialCount = 0;
  object.traverse((part) => {
    if (!part.isMesh && !part.isSkinnedMesh && !part.isInstancedMesh) return;
    meshes++;
    const geometry = part.geometry;
    const index = geometry?.index;
    const position = geometry?.attributes?.position;
    if (index) triangles += Math.floor(index.count / 3);
    else if (position) triangles += Math.floor(position.count / 3);
    const mats = Array.isArray(part.material) ? part.material : [part.material];
    materialCount += mats.filter(Boolean).length;
  });
  return { meshes, triangles, materialCount };
}

function formatFileSize(bytes) {
  return `${(Math.max(0, bytes) / 1_000_000).toFixed(1)} MB`;
}

function renderTree(query = '') {
  const needle = query.trim().toLocaleLowerCase();
  const filtered = allNodes.filter((entry) => !needle || entry.name.toLocaleLowerCase().includes(needle) || entry.path.toLocaleLowerCase().includes(needle));
  const included = new Set(filtered);
  const entryByObject = new Map(allNodes.map((entry) => [entry.object, entry]));
  if (needle) {
    for (const entry of filtered) {
      for (let parent = entry.object.parent; parent && parent !== loadedRoot; parent = parent.parent) {
        const ancestor = entryByObject.get(parent);
        if (ancestor) included.add(ancestor);
      }
    }
  }
  const visibleEntries = allNodes.filter((entry) => {
    if (!included.has(entry)) return false;
    if (needle) return true;
    for (let parent = entry.object.parent; parent && parent !== loadedRoot; parent = parent.parent) {
      if (collapsedGroups.has(parent.id)) return false;
    }
    return true;
  });
  ui.tree.replaceChildren();
  ui.treeEmpty.hidden = allNodes.length > 0;
  ui.tree.hidden = allNodes.length === 0;
  ui.nodeCount.textContent = String(filtered.length);
  const fragment = document.createDocumentFragment();
  for (const entry of visibleEntries) {
    const row = document.createElement('div');
    row.className = `tree-row${selectedNode?.id === entry.id ? ' selected' : ''}`;
    row.style.setProperty('--depth', Math.min(entry.depth, 8));
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-selected', selectedNode?.id === entry.id ? 'true' : 'false');
    row.title = entry.path;

    const disclosure = document.createElement('button');
    disclosure.type = 'button';
    const expandable = !entry.isMesh && entry.object.children.length > 0;
    disclosure.className = `tree-disclosure${expandable ? '' : ' spacer'}`;
    if (expandable) {
      const collapsed = collapsedGroups.has(entry.id);
      disclosure.setAttribute('aria-expanded', String(!collapsed));
      disclosure.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} ${entry.name}`);
      disclosure.title = `${collapsed ? 'Expand' : 'Collapse'} group`;
      disclosure.innerHTML = '<svg viewBox="0 0 16 16"><path d="m5 6 3 3 3-3"/></svg>';
      disclosure.classList.toggle('collapsed', collapsed);
      disclosure.addEventListener('click', (event) => {
        event.stopPropagation();
        if (collapsedGroups.has(entry.id)) collapsedGroups.delete(entry.id);
        else collapsedGroups.add(entry.id);
        renderTree(ui.search.value);
      });
    } else {
      disclosure.setAttribute('aria-hidden', 'true');
      disclosure.tabIndex = -1;
    }

    const select = document.createElement('button');
    select.className = 'tree-select';
    select.type = 'button';
    select.dataset.nodeId = String(entry.id);
    select.innerHTML = `<span class="tree-branch ${entry.isMesh ? 'mesh' : 'group'}"></span><span class="tree-name"></span>`;
    select.querySelector('.tree-name').textContent = entry.name;
    select.addEventListener('click', () => selectNode(entry.object));

    const visibility = document.createElement('button');
    visibility.className = 'tree-eye';
    visibility.type = 'button';
    visibility.title = entry.object.visible ? 'Hide structure' : 'Show structure';
    visibility.setAttribute('aria-label', `${visibility.title}: ${entry.name}`);
    visibility.innerHTML = entry.object.visible
      ? '<svg viewBox="0 0 20 20"><path d="M2 10s2.8-4.5 8-4.5 8 4.5 8 4.5-2.8 4.5-8 4.5S2 10 2 10Z"/><circle cx="10" cy="10" r="2"/></svg>'
      : '<svg viewBox="0 0 20 20"><path d="M3 3l14 14M8.2 5.8c.6-.2 1.2-.3 1.8-.3 5.2 0 8 4.5 8 4.5a13 13 0 0 1-2 2.4M5.3 6.8A13 13 0 0 0 2 10s2.8 4.5 8 4.5c.7 0 1.3-.1 1.9-.3"/></svg>';
    visibility.addEventListener('click', (event) => {
      event.stopPropagation();
      entry.object.visible = !entry.object.visible;
      invalidateVisibleStructureMeshes();
      renderTree(ui.search.value);
      if (selectedNode === entry.object) updateInspector(entry.object);
      if (selectionBox) selectionBox.visible = Boolean(selectedNode?.visible);
    });
    row.append(disclosure, select, visibility);
    fragment.append(row);
  }
  ui.tree.append(fragment);
}

function clearSelectionHighlight() {
  if (!selectionBox) return;
  scene.remove(selectionBox);
  selectionBox.traverse((object) => object.material?.dispose?.());
  selectionBox = null;
  selectionHighlightSources = [];
}

function updateSelectionHighlight() {
  if (!selectionBox) return;
  for (const { source, overlay } of selectionHighlightSources) {
    // The scene renderer maintains source matrices. Re-forcing each selected
    // mesh and its ancestors here repeated matrix walks before every draw.
    overlay.matrix.copy(source.matrixWorld);
    overlay.matrixWorldNeedsUpdate = true;
    overlay.visible = true;
    for (let parent = source; parent; parent = parent.parent) overlay.visible = overlay.visible && parent.visible;
    if (source.morphTargetInfluences && overlay.morphTargetInfluences) {
      for (let index = 0; index < source.morphTargetInfluences.length; index += 1) {
        overlay.morphTargetInfluences[index] = source.morphTargetInfluences[index];
      }
    }
    if (source.isInstancedMesh && overlay.isInstancedMesh) {
      overlay.instanceMatrix.copy(source.instanceMatrix);
      overlay.count = source.count;
    }
  }
}

function selectNode(object) {
  selectedNode = object;
  selectedLead = null;
  clearSelectionHighlight();
  selectionBox = new THREE.Group();
  selectionBox.name = 'Selected mesh surface highlight';
  selectionBox.renderOrder = 10;
  scene.add(selectionBox);
  const isSurface = object.isMesh || object.isSkinnedMesh || object.isInstancedMesh;
  const material = new THREE.MeshBasicMaterial({
    color: 0xff765f,
    transparent: true,
    opacity: isSurface ? 0.52 : 0.24,
    depthTest: !isSurface,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  object.traverse((source) => {
    if (!(source.isMesh || source.isSkinnedMesh || source.isInstancedMesh)) return;
    const overlay = source.isInstancedMesh
      ? new THREE.InstancedMesh(source.geometry, material, source.count)
      : source.isSkinnedMesh
        ? new THREE.SkinnedMesh(source.geometry, material)
        : new THREE.Mesh(source.geometry, material);
    if (source.isSkinnedMesh) {
      overlay.bind(source.skeleton, source.bindMatrix);
      overlay.bindMode = source.bindMode;
      overlay.bindMatrixInverse.copy(source.bindMatrixInverse);
    }
    overlay.matrixAutoUpdate = false;
    overlay.matrix.copy(source.matrixWorld);
    overlay.matrixWorldNeedsUpdate = true;
    // The overlay shares the source geometry and transform, so normal frustum
    // culling remains valid and avoids drawing selected anatomy off-screen.
    overlay.frustumCulled = source.frustumCulled;
    if (source.morphTargetInfluences) {
      overlay.morphTargetInfluences = source.morphTargetInfluences.slice();
      overlay.morphTargetDictionary = source.morphTargetDictionary;
    }
    if (source.isInstancedMesh) {
      overlay.instanceMatrix.copy(source.instanceMatrix);
      overlay.count = source.count;
    }
    overlay.name = `Selection surface: ${source.name || source.type}`;
    overlay.renderOrder = 10;
    selectionBox.add(overlay);
    selectionHighlightSources.push({ source, overlay });
  });
  selectionBox.visible = Boolean(object.visible);
  updateSelectionHighlight();
  updateInspector(object);
  renderTree(ui.search.value);
  openMobileInspectorPanel();
}

function selectECGLead(name) {
  if (!ECG_LEAD_DETAILS[name]) return;
  selectedNode = null;
  selectedLead = name;
  clearSelectionHighlight();
  updateInspector(null);
  renderTree(ui.search.value);
  openMobileInspectorPanel();
}

function deselectNode() {
  selectedNode = null;
  selectedLead = null;
  clearSelectionHighlight();
  updateInspector(null);
  renderTree(ui.search.value);
}

function updateInspector(object) {
  if (!object) {
    if (selectedLead) {
      renderECGLeadInspector(selectedLead);
      return;
    }
    ui.inspectorContent.classList.remove('lead-inspector');
    ui.inspectorEmpty.hidden = false;
    ui.inspectorContent.hidden = true;
    ui.selectedCrumb.textContent = 'View';
    ui.hud.hidden = true;
    ui.isolate.disabled = true;
    ui.toggle.disabled = true;
    return;
  }
  ui.inspectorContent.classList.remove('lead-inspector');
  ui.inspectorEmpty.hidden = true;
  ui.inspectorContent.hidden = false;
  const entry = allNodes.find((item) => item.object === object);
  const name = entry?.name || object.name || object.type;
  const facts = countMeshFacts(object);
  ui.selectedName.textContent = name;
  ui.selectedType.textContent = object.isMesh ? 'Mesh' : object.type;
  ui.selectedPath.textContent = entry?.path || name;
  renderStructureDescription(object, entry, name);
  ui.geometry.textContent = `${facts.meshes} ${facts.meshes === 1 ? 'mesh' : 'meshes'}`;
  ui.triangles.textContent = facts.triangles.toLocaleString();
  ui.materials.textContent = String(facts.materialCount);
  ui.isolate.disabled = false;
  ui.toggle.disabled = false;
  ui.toggle.textContent = object.visible ? 'Hide' : 'Show';
  ui.selectedCrumb.textContent = name;
  el('hud-structure').textContent = name;
  ui.hud.hidden = false;
}

function renderECGLeadInspector(name) {
  const detail = ECG_LEAD_DETAILS[name];
  if (!detail) return;
  ui.inspectorEmpty.hidden = true;
  ui.inspectorContent.hidden = false;
  ui.inspectorContent.classList.add('lead-inspector');
  ui.selectedName.textContent = `Lead ${name}`;
  ui.selectedType.textContent = detail.kind;
  ui.selectedPath.textContent = 'Standard 12-lead ECG · Electrical viewpoint';
  ui.geometry.textContent = '—';
  ui.triangles.textContent = '—';
  ui.materials.textContent = '—';
  ui.isolate.disabled = true;
  ui.toggle.disabled = true;
  ui.selectedCrumb.textContent = `Lead ${name}`;
  el('hud-structure').textContent = `Lead ${name}`;
  ui.hud.hidden = false;

  const container = el('structure-description');
  container.replaceChildren();
  container.hidden = false;
  for (const [sectionTitle, sectionText] of detail.sections) {
    const section = document.createElement('section');
    section.className = 'description-section';
    const heading = document.createElement('h4');
    heading.textContent = sectionTitle;
    const text = document.createElement('p');
    text.className = 'description-text';
    text.textContent = sectionText;
    section.append(heading, text);
    container.append(section);
  }
}

function renderStructureDescription(object, entry, name) {
  const container = el('structure-description');
  container.replaceChildren();
  const sourceId = object.userData?.formeSourceId;
  container.hidden = false;
  const loading = document.createElement('p');
  loading.className = 'description-loading';
  loading.textContent = 'Loading description…';
  container.append(loading);

  if (!structureDescriptionsPromise) {
    structureDescriptionsPromise = fetch('/models/structure-descriptions.json').then((response) => {
      if (!response.ok) throw new Error('Descriptions are unavailable');
      return response.json();
    });
  }

  structureDescriptionsPromise.then((index) => {
    if (selectedNode !== object) return;
    const description = index[sourceId] || Object.values(index).find((item) => item.name === name);
    container.replaceChildren();
    if (!description?.sections?.length) {
      container.hidden = true;
      return;
    }
    for (const section of description.sections) {
      const block = document.createElement('section');
      block.className = 'description-section';
      const heading = document.createElement('h4');
      heading.textContent = section.name || 'Details';
      const text = document.createElement('p');
      text.className = 'description-text';
      text.textContent = section.text;
      block.append(heading, text);
      container.append(block);
    }
  }).catch(() => {
    if (selectedNode !== object) return;
    container.hidden = true;
    structureDescriptionsPromise = null;
  });
}

function resetCamera() {
  camera.position.set(2.9, 1.8, 3.6);
  controls.target.set(0, 0, 0);
  updateCameraClipping();
  controls.update();
}

function refreshViewerBounds() {
  if (!loadedRoot) return;
  loadedRoot.updateWorldMatrix(true, true);
  const bounds = new THREE.Box3().setFromObject(loadedRoot);
  if (!bounds.isEmpty()) bounds.getBoundingSphere(viewerBoundsSphere);
}

function updateCameraClipping() {
  const radius = Math.max(viewerBoundsSphere.radius, 0.05);
  const contentDistance = camera.position.distanceTo(viewerBoundsSphere.center);
  // Keep the depth-buffer range tight around the current view. A fixed far
  // plane of 500 with a 0.005 near plane loses useful depth precision on our
  // normalized models, making nearly coplanar anatomy layers flicker at a
  // distance and as the camera zooms out.
  const near = Math.max(0.001, Math.min(contentDistance * 0.02, radius * 0.025));
  const far = Math.max(near + 1, contentDistance + radius * 2.5);
  if (Math.abs(camera.near - near) < 0.0001 && Math.abs(camera.far - far) < 0.01) return;
  camera.near = near;
  camera.far = far;
  camera.updateProjectionMatrix();
}

function fitModel(root = loadedRoot) {
  if (!root || !modelGroup) return;
  // Measure the imported model in its unnormalized local frame. The initial
  // load already scales modelGroup, so measuring without clearing that parent
  // transform would apply the fit twice when the user clicks Fit again.
  modelGroup.position.set(0, 0, 0);
  modelGroup.scale.setScalar(1);
  modelGroup.updateMatrixWorld(true);
  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(root);
  if (bounds.isEmpty()) return;
  const fit = fitBounds(bounds);
  modelGroup.scale.setScalar(fit.scale);
  modelGroup.position.copy(fit.center).multiplyScalar(-fit.scale);
  modelGroup.updateMatrixWorld(true);
  controls.target.set(0, 0, 0);
  const radius = Math.max(fit.extents.length() * fit.scale * 0.5, 0.1);
  const verticalHalfFov = THREE.MathUtils.degToRad(camera.fov * 0.5);
  const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * Math.max(camera.aspect, 0.1));
  const fitDistance = (radius / Math.sin(Math.min(verticalHalfFov, horizontalHalfFov))) * 0.94;
  const viewDirection = new THREE.Vector3(0.84, 0.58, 1).normalize();
  camera.position.copy(viewDirection.multiplyScalar(fitDistance));
  refreshViewerBounds();
  updateCameraClipping();
  controls.minDistance = 0.12;
  controls.maxDistance = 35;
  controls.update();
  updateSelectionHighlight();
}

function freezeStaticModelTransforms(root) {
  if (!root) return;
  // Library systems and imported structures are static; the heart cycle uses
  // morph weights, not object transforms. Keep their authored local matrices
  // but avoid recomposing thousands of identical matrices on every render.
  root.updateWorldMatrix(true, true);
  root.traverse((object) => { object.matrixAutoUpdate = false; });
}

function captureViewerPose() {
  if (!loadedRoot || !modelGroup) return null;
  return {
    cameraPosition: camera.position.clone(),
    cameraUp: camera.up.clone(),
    cameraZoom: camera.zoom,
    target: controls.target.clone(),
    modelPosition: modelGroup.position.clone(),
    modelScale: modelGroup.scale.clone(),
  };
}

function restoreViewerPose(pose) {
  if (!pose || !loadedRoot || !modelGroup) return;
  modelGroup.position.copy(pose.modelPosition);
  modelGroup.scale.copy(pose.modelScale);
  modelGroup.updateMatrixWorld(true);
  camera.position.copy(pose.cameraPosition);
  camera.up.copy(pose.cameraUp);
  camera.zoom = pose.cameraZoom;
  controls.target.copy(pose.target);
  updateCameraClipping();
  controls.update();
}

function frameObject(object, preferredDirection = null, { distanceScale = 1 } = {}) {
  if (!object) return;
  object.updateWorldMatrix(true, true);
  const bounds = new THREE.Box3().setFromObject(object);
  if (bounds.isEmpty()) return;

  frameBounds(bounds, preferredDirection, distanceScale);
}

function frameBounds(bounds, preferredDirection = null, distanceScale = 1) {
  const center = bounds.getCenter(new THREE.Vector3());
  const sphere = bounds.getBoundingSphere(new THREE.Sphere());
  const verticalHalfFov = THREE.MathUtils.degToRad(camera.fov * 0.5);
  const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * Math.max(camera.aspect, 0.1));
  const distance = Math.max(sphere.radius / Math.sin(Math.min(verticalHalfFov, horizontalHalfFov)) * 0.94 * distanceScale, 0.12);
  const viewDirection = preferredDirection?.clone()
    || camera.position.clone().sub(controls.target).normalize();
  if (viewDirection.lengthSq() < 1e-6) viewDirection.set(0.84, 0.58, 1).normalize();

  controls.target.copy(center);
  camera.position.copy(center).addScaledVector(viewDirection, distance);
  updateCameraClipping();
  controls.update();
}

function showAll() {
  if (!loadedRoot) return;
  loadedRoot.traverse((object) => { object.visible = true; });
  invalidateVisibleStructureMeshes();
  if (ecgSupportVisibility) setECGSupportVisibility(true);
  renderTree(ui.search.value);
  if (selectedNode) updateInspector(selectedNode);
  showToast('All structures are visible.');
}

function setIsolate(object) {
  if (!loadedRoot) return;
  loadedRoot.traverse((part) => { part.visible = part === object || object.parent === part || isAncestor(object, part); });
  invalidateVisibleStructureMeshes();
  // Keep ancestors visible so the selected node remains attached to its scene.
  for (let parent = object.parent; parent; parent = parent.parent) parent.visible = true;
  if (ecgSupportVisibility) setECGSupportVisibility(true);
  renderTree(ui.search.value);
  updateInspector(object);
  showToast('Showing the selected structure.');
}

function isAncestor(ancestor, object) {
  for (let node = object.parent; node; node = node.parent) if (node === ancestor) return true;
  return false;
}

function focusHeart({ frontView = false, distanceScale = 1 } = {}) {
  if (!loadedRoot) return;
  const heartTerms = /heart|cardiac|atri(?:um|a)|ventric(?:le|ular)|myocard|coronary|pericard/i;
  const matches = allNodes.filter((entry) => heartTerms.test(entry.name));
  if (!matches.length) {
    ui.search.value = 'heart';
    renderTree('heart');
    showToast('No heart-named structures found. Load a labeled heart model.', 'error');
    return;
  }

  ui.search.value = '';
  renderTree('');

  const preferred = matches.find((entry) => /^heart$/i.test(entry.name))
    || matches.find((entry) => /heart|cardiac/i.test(entry.name) && !entry.isMesh)
    || matches.find((entry) => entry.isMesh)
    || matches[0];
  selectNode(preferred.object);
  frameObject(preferred.object, frontView ? new THREE.Vector3(0, 0, 1) : null, { distanceScale });
  showToast('Heart centered in view.');
}

function hideECGFasciaLayers() {
  if (!loadedRoot) return;
  const fasciaNames = /\bfascia(?:e)?\b/i;
  ecgSupportVisibility ||= new Map();
  let hidden = 0;
  for (const entry of allNodes) {
    if (!fasciaNames.test(`${entry.path} ${entry.name}`)) continue;
    if (!ecgSupportVisibility.has(entry.object)) ecgSupportVisibility.set(entry.object, entry.object.visible);
    entry.object.visible = false;
    hidden += 1;
  }
  if (hidden) {
    invalidateVisibleStructureMeshes();
    renderTree(ui.search.value);
    if (selectedNode && allNodes.some((entry) => !entry.object.visible && (entry.object === selectedNode || isAncestor(entry.object, selectedNode)))) {
      deselectNode();
    }
  }
}

// ECG placement only needs the bony chest and shoulder landmarks. Showing the
// complete skeleton/connective-tissue GLBs adds thousands of unrelated meshes
// to every frame, so temporarily mask those models while the guide is active.
// Keep the original visibility per mesh to restore the user's exact scene on exit.
function setECGSupportVisibility(enabled) {
  if (!loadedRoot) return;
  if (!enabled) {
    if (!ecgSupportVisibility) return;
    for (const [mesh, visible] of ecgSupportVisibility) mesh.visible = visible;
    ecgSupportVisibility = null;
    invalidateVisibleStructureMeshes();
    renderTree(ui.search.value);
    requestRender();
    return;
  }
  const skeletalLandmark = /\b(?:rib|sternum|manubrium|xiphoid|clavicle|scapula|thoracic vertebra)\b|bones of (?:the )?(?:pectoral girdle|thoracic cage)/i;
  const connectiveLandmark = /costal cartilag|sternoclavicular ligament|costotransverse ligament|radiate ligament of head of rib|interarticular ligament of head of rib|interchondral ligament|sternocostal ligament|costochondral|coracoclavicular|\b(?:trapezoid|conoid) ligament\b|\b(?:pectoral|clavipectoral) fascia\b/i;
  const sex = activeHeartModelId.startsWith('female-') ? 'female' : 'male';
  const supportSystems = new Set(['Skeletal System', 'Connective Tissue']);
  const supportRoots = new Set();
  loadedRoot.traverse((object) => {
    if (!object.isMesh && supportSystems.has(object.name?.trim()) && loadedLibraryModels.some((model) => model.id.startsWith(`${sex}-2024-`) && model.system === object.name.trim())) {
      supportRoots.add(object);
    }
  });

  ecgSupportVisibility ||= new Map();
  for (const entry of allNodes) {
    if (!entry.isMesh) continue;
    let supportRoot = null;
    for (let parent = entry.object; parent && parent !== loadedRoot; parent = parent.parent) {
      if (supportRoots.has(parent)) { supportRoot = parent; break; }
    }
    if (!supportRoot) continue;
    const isSkeletal = supportRoot.name.trim() === 'Skeletal System';
    const path = `${entry.path} ${entry.name}`;
    const keep = isSkeletal ? skeletalLandmark.test(path) : connectiveLandmark.test(path);
    if (!ecgSupportVisibility.has(entry.object)) ecgSupportVisibility.set(entry.object, entry.object.visible);
    entry.object.visible = keep && ecgSupportVisibility.get(entry.object);
  }
  hideECGFasciaLayers();
  invalidateVisibleStructureMeshes();
  renderTree(ui.search.value);
  requestRender();
}

async function ensureECGSupportModels() {
  if (!activeHeartModelId || !libraryModels.length) return true;
  const sex = activeHeartModelId.startsWith('female-') ? 'female' : 'male';
  const required = libraryModels.filter((model) =>
    model.id.startsWith(`${sex}-2024-`) && modelQuality(model) === 'original'
      && /^(Skeletal System|Connective Tissue)$/i.test(model.system),
  );
  const loadedIds = new Set(loadedLibraryModels.map((model) => model.id));
  const missing = required.filter((model) => !loadedIds.has(model.id));
  if (!missing.length) return true;
  if (ui.libraryLoad.disabled) {
    showToast('Wait for the current model load to finish before opening ECG guides.', 'error');
    return false;
  }

  const loaded = await appendLibraryModelsToScene(missing);
  if (loaded) {
    const requiredIds = new Set(required.map((model) => model.id));
    for (const checkbox of ui.library.querySelectorAll('input[type="checkbox"]')) {
      if (requiredIds.has(checkbox.value)) checkbox.checked = true;
    }
    for (const model of required) librarySelectionsBySex.get(model.model)?.add(model.id);
  }
  return loaded && required.every((model) => loadedLibraryModels.some((entry) => entry.id === model.id));
}

async function parseModel(files) {
  const modelFile = files.find((file) => /\.(glb|gltf)$/i.test(file.name));
  if (!modelFile) throw new Error('Choose a .glb or .gltf model file.');
  setStatus(`Loading ${modelFile.name}…`);
  const blobUrls = [];
  const fileByName = new Map(files.map((file) => [file.name.toLocaleLowerCase(), file]));
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (/^(data:|blob:)/i.test(url)) return url;
    const decoded = decodeURIComponent(url.split(/[?#]/)[0]);
    const file = fileByName.get(decoded.toLocaleLowerCase()) || fileByName.get(decoded.split('/').at(-1).toLocaleLowerCase());
    if (!file) return url;
    const localUrl = URL.createObjectURL(file);
    blobUrls.push(localUrl);
    return localUrl;
  });
  await MeshoptDecoder.ready;
  const loader = createGLTFLoader(manager);
  try {
    const data = await modelFile.arrayBuffer();
    const gltf = await loader.parseAsync(data, '');
    return { gltf, modelFile, blobUrls };
  } catch (error) {
    blobUrls.forEach(URL.revokeObjectURL);
    throw error;
  }
}

async function installLoadedScene({ root, displayName = '', catalogId = '', catalogModels = [], modelCount = 1, animations = [], heartRoot = null, heartModelId = catalogId, blobUrls = [], modelFileBytes = 0, textureBytes = 0, loadNotice = '' } = {}) {
  clearSelectionHighlight();
  if (modelGroup?.userData.blobUrls) modelGroup.userData.blobUrls.forEach(URL.revokeObjectURL);
  if (mixer && loadedRoot) {
    mixer.stopAllAction();
    mixer.uncacheRoot(activeAnimationRoot || loadedRoot);
  }
  mixer = null;
  activeAnimationRoot = null;
  if (modelGroup) {
    releaseSourceShaderUniforms(modelGroup);
    scene.remove(modelGroup);
    modelGroup.traverse((object) => {
      object.geometry?.dispose?.();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => material?.dispose?.());
    });
  }
  animationAction = null;
  animationPlaying = false;
  activeHeartRoot = heartRoot;
  ui.focusHeart.hidden = !heartRoot;
  ui.controlsMenuLabel.textContent = heartRoot ? 'Heart controls' : 'View controls';
  ui.controlsMenu.hidden = true;
  ui.controlsMenuToggle.setAttribute('aria-expanded', 'false');
  activeHeartModelId = heartModelId;
  loadedLibraryModels = catalogModels;
  ecgTorsoContextPromise = null;
  ecgTorsoContextEligible = false;
  ecgSupportModelBlobs.clear();
  ecgTorsoBlobs.clear();
  ecgSupportVisibility = null;
  conductionOverlay = null;
  ecgLeadOverlay = null;
  conductionLines = [];
  conductionNodes = [];
  conductionMorphFollowers = [];
  conductionMorphAnchors = [];
  depolarizationShell = null;
  depolarizationMeshPairs = [];
  ui.conduction.disabled = true;
  ui.conduction.setAttribute('aria-pressed', 'false');
  ui.depolarization.disabled = true;
  ui.depolarization.setAttribute('aria-pressed', 'false');
  ui.ecg.disabled = true;
  ui.ecg.setAttribute('aria-pressed', 'false');
  modelGroup = new THREE.Group();
  modelGroup.name = 'Loaded anatomy fit';
  loadedRoot = root;
  invalidateVisibleStructureMeshes();
  modelGroup.add(loadedRoot);
  scene.add(modelGroup);
  const heartClip = animations.find((clip) => clip.name?.startsWith('Heart cycle'));
  const clip = heartClip || animations[0];
  if (heartRoot && clip) {
    mixer = new THREE.AnimationMixer(heartRoot);
    activeAnimationRoot = heartRoot;
    animationAction = mixer.clipAction(clip);
    if (heartClip) animationAction.timeScale = 30;
    animationAction.play();
    animationPlaying = true;
  }
  ui.animation.disabled = !animationAction;
  updateAnimationButton();
  modelFileName = displayName || 'Anatomy model';
  loadedModelFileBytes = modelFileBytes;
  loadedTextureBytes = textureBytes;
  allNodes = collectNodes(loadedRoot);
  nodeMap = new Map(allNodes.map((entry) => [entry.id, entry.object]));
  collapsedGroups = new Set(allNodes.filter((entry) => !entry.isMesh && entry.object.children.length > 0).map((entry) => entry.id));
  selectedNode = null;
  selectedLead = null;
  updateInspector(null);
  fitModel(loadedRoot);
  freezeStaticModelTransforms(loadedRoot);
  if (heartRoot) {
    const integumentaryAlreadyLoaded = allNodes.some((entry) => /Integumentary System/i.test(entry.name));
    ecgTorsoContextEligible = !integumentaryAlreadyLoaded;
    ui.conduction.disabled = false;
    ui.depolarization.disabled = false;
    ui.ecg.disabled = false;
    if (isHeartModelId(heartModelId) && !isReducedHeartModelId(heartModelId)) {
      scheduleECGBackgroundPreload(heartModelId);
    }
  }
  renderTree('');
  const facts = countMeshFacts(loadedRoot);
  ui.modelTitle.textContent = displayName;
  ui.source.textContent = displayName;
  if (catalogId) {
    const catalogModel = libraryModels.find((model) => model.id === catalogId);
    if (catalogModel) {
      const selection = librarySelectionsBySex.get(catalogModel.model);
      selectedModelQuality.set(catalogModel.model, modelQuality(catalogModel));
      if (selection) {
        for (const model of libraryModels) {
          if (model.model === catalogModel.model && modelSystem(model) === modelSystem(catalogModel)) selection.delete(model.id);
        }
        selection.add(catalogId);
      }
      if (catalogModel.model === selectedLibrarySex) {
        renderModelQualityControl();
        renderLibrarySexOptions();
        renderEmptyModelOptions();
      }
    }
    const checkbox = Array.from(ui.library.querySelectorAll('input[type="checkbox"]'))
      .find((input) => input.value === catalogId);
    if (checkbox) checkbox.checked = true;
  }
  ui.meshSummary.textContent = `${facts.meshes.toLocaleString()} meshes · ${facts.triangles.toLocaleString()} triangles · Model ${formatFileSize(loadedModelFileBytes)} · Textures ${formatFileSize(loadedTextureBytes)}`;
  ui.emptyState.hidden = true;
  ui.isolate.disabled = true;
  ui.toggle.disabled = true;
  for (const id of ['fit-view', 'reset-view', 'show-all']) el(id).disabled = false;
  el('focus-heart').disabled = false;
  setStatus(`${modelCount} model${modelCount === 1 ? '' : 's'} loaded`);
  showToast(loadNotice || `Loaded ${displayName}.`);
  modelGroup.userData.blobUrls = blobUrls;
  requestRender();
}

async function loadFiles(fileList, { displayName = '', catalogId = '', textureBytes: providedTextureBytes = 0 } = {}) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  let modelFileBytes = files.reduce((total, file) => total + (file.size || 0), 0);
  let textureBytes = providedTextureBytes;
  try {
    const selectedFile = files.find((file) => /\.(glb|gltf)$/i.test(file.name));
    setModelLoadProgress(`Building meshes · ${selectedFile?.name || 'local model'}`);
    const { gltf, modelFile, blobUrls } = await parseModel(files);
    const heartRoot = isHeartModelId(catalogId) ? gltf.scene : null;
    setModelLoadProgress(`Applying materials · ${displayName || modelFile.name}`);
    if (heartRoot) {
      const textureVariant = heartTextureVariant(catalogId);
      await applySourceMaterials(heartRoot, { heart: true, textureVariant });
      textureBytes += getAppliedTextureBytes(heartRoot, { heart: true, textureVariant });
    }
    else if (catalogId) await applySourceMaterials(gltf.scene, {
      textureVariant: modelQuality(libraryModels.find((model) => model.id === catalogId)),
    });
    else if (displayName.startsWith('Detailed · ')) {
      applyDetailedPreviewMaterials(gltf.scene);
    }
    await installLoadedScene({
      root: gltf.scene,
      displayName: displayName || modelFile.name,
      catalogId,
      catalogModels: libraryModels.filter((model) => model.id === catalogId),
      animations: gltf.animations || [],
      heartRoot,
      heartModelId: heartRoot ? catalogId : '',
      blobUrls,
      modelFileBytes,
      textureBytes,
    });
  } catch (error) {
    setStatus('Could not load model');
    showToast(error?.message || 'The model could not be loaded.', 'error');
  } finally {
    clearModelLoadProgress();
  }
}

function selectedLibraryModels() {
  const selectedIds = new Set(Array.from(
    ui.library.querySelectorAll('input[type="checkbox"]:checked'),
    (input) => input.value,
  ));
  return libraryModels.filter((model) => selectedIds.has(model.id));
}

function setModelLoadProgress(label, percent = null) {
  ui.modelLoadProgress.hidden = false;
  ui.modelLoadLabel.textContent = label;
  const indeterminate = percent === null || !Number.isFinite(percent);
  ui.modelLoadFill.classList.toggle('indeterminate', indeterminate);
  if (indeterminate) {
    if (Number.parseFloat(ui.modelLoadFill.style.width) < 4) ui.modelLoadFill.style.width = '4%';
    ui.modelLoadPercent.textContent = '';
    ui.modelLoadTrack.removeAttribute('aria-valuenow');
    return;
  }
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  ui.modelLoadFill.style.width = `${value}%`;
  ui.modelLoadPercent.textContent = `${value}%`;
  ui.modelLoadTrack.setAttribute('aria-valuenow', String(value));
}

function clearModelLoadProgress() {
  ui.modelLoadProgress.hidden = true;
  ui.modelLoadFill.classList.remove('indeterminate');
  ui.modelLoadFill.style.width = '0%';
  ui.modelLoadPercent.textContent = '';
  ui.modelLoadTrack.setAttribute('aria-valuenow', '0');
}

async function fetchModelBlob(url, onProgress, model = null) {
  const files = model?.chunks?.length
    ? model.chunks.map((path) => `/models/${path}`)
    : [url];
  const expectedBytes = model?.fileSizeBytes || 0;
  const blobs = [];
  let completedBytes = 0;
  for (const [fileIndex, fileUrl] of files.entries()) {
    const response = await fetch(fileUrl);
    if (!response.ok) throw new Error(`Could not load ${fileUrl.split('/').pop()}.`);
    const fileBytes = Number(response.headers.get('content-length')) || 0;
    const totalBytes = expectedBytes || fileBytes;
    if (!response.body?.getReader) {
      const blob = await response.blob();
      blobs.push(blob);
      completedBytes += blob.size;
      onProgress(totalBytes ? Math.min(completedBytes / totalBytes, 1) : (fileIndex + 1) / files.length);
      continue;
    }
    const reader = response.body.getReader();
    const parts = [];
    let receivedBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      receivedBytes += value.byteLength;
      const progress = totalBytes
        ? (completedBytes + receivedBytes) / totalBytes
        : (fileIndex + receivedBytes / (fileBytes || receivedBytes)) / files.length;
      onProgress(Math.min(progress, 1));
    }
    blobs.push(new Blob(parts));
    completedBytes += receivedBytes;
  }
  onProgress(1);
  return new Blob(blobs, { type: 'model/gltf-binary' });
}

async function fetchECGSupportModelBlob(model, onProgress) {
  const cached = ecgSupportModelBlobs.get(model.id);
  if (cached) {
    ecgSupportModelBlobs.delete(model.id);
    onProgress?.(1);
    return cached;
  }
  const pending = ecgSupportModelFetches.get(model.id);
  if (pending) {
    const blob = await pending;
    ecgSupportModelBlobs.delete(model.id);
    onProgress?.(1);
    return blob;
  }
  return fetchModelBlob(`/models/${model.file}`, onProgress, model);
}

function scheduleECGBackgroundPreload(modelId) {
  const preload = () => {
    if (modelId !== activeHeartModelId || !activeHeartRoot) return;
    void preloadECGAssets(modelId);
  };
  if (window.requestIdleCallback) window.requestIdleCallback(preload, { timeout: 1800 });
  else window.setTimeout(preload, 300);
}

async function preloadECGAssets(modelId) {
  if (!isHeartModelId(modelId) || isReducedHeartModelId(modelId)) return;
  const sex = modelId.startsWith('female-2024') ? 'female' : 'male';
  const required = libraryModels.filter((model) =>
    model.id.startsWith(`${sex}-2024-`) && modelQuality(model) === 'original'
      && /^(Skeletal System|Connective Tissue)$/i.test(model.system),
  );
  const loadedIds = new Set(loadedLibraryModels.map((model) => model.id));
  const metadataPromise = loadECGLandmarks(modelId).catch((error) => {
    console.warn('ECG guide metadata could not be preloaded.', error);
  });
  const torsoPromise = ecgTorsoContextEligible
    ? fetchECGTorsoBlob(modelId).then((blob) => {
      if (modelId === activeHeartModelId) {
        const sexModel = modelId.startsWith('female-2024') ? 'female' : 'male';
        ecgTorsoBlobs.set(`${sexModel}-2024-integumentary-system`, blob);
      }
    }).catch((error) => console.warn('ECG torso data could not be preloaded.', error))
    : Promise.resolve();

  // Warm the larger model files one at a time during idle time. They remain
  // detached from the scene and are parsed only if ECG guides are requested.
  for (const model of required) {
    if (loadedIds.has(model.id) || modelId !== activeHeartModelId) continue;
    let pending = ecgSupportModelFetches.get(model.id);
    if (!pending) {
      pending = fetchModelBlob(`/models/${model.file}`, () => {}, model);
      ecgSupportModelFetches.set(model.id, pending);
    }
    try {
      const blob = await pending;
      if (modelId === activeHeartModelId && !loadedLibraryModels.some((entry) => entry.id === model.id)) {
        ecgSupportModelBlobs.set(model.id, blob);
      }
    } catch (error) {
      console.warn(`ECG support data could not be preloaded: ${model.system}.`, error);
    } finally {
      if (ecgSupportModelFetches.get(model.id) === pending) ecgSupportModelFetches.delete(model.id);
    }
  }
  await Promise.all([metadataPromise, torsoPromise]);
}

async function loadSelectedLibraryModels(requestedModels = null) {
  if (ui.libraryLoad.disabled) return false;
  const models = Array.isArray(requestedModels) ? requestedModels : selectedLibraryModels();
  if (!models.length) {
    showToast('Select one or more offline systems first.', 'error');
    return false;
  }
  ui.libraryLoad.disabled = true;
  ui.emptyModelLoad.disabled = true;
  const viewerPose = captureViewerPose();
  try {
    setStatus(`Loading ${models.length} offline model${models.length === 1 ? '' : 's'}…`);
    const loaded = [];
    let usedCompatibleQualityFallback = false;
    for (const [index, model] of models.entries()) {
      const assetModel = compatibleLibraryModelAsset(model);
      usedCompatibleQualityFallback ||= assetModel.file !== model.file;
      setStatus(`Loading ${model.label} (${index + 1}/${models.length})…`);
      setModelLoadProgress(`Downloading ${model.system} · ${index + 1} of ${models.length}`, (index / models.length) * 100);
      const blob = await fetchECGSupportModelBlob(assetModel, (fraction) => {
        setModelLoadProgress(
          `Downloading ${model.system} · ${index + 1} of ${models.length}`,
          fraction === null ? null : ((index + fraction * 0.7) / models.length) * 100,
        );
      });
      const file = new File([blob], `${model.id}.glb`, { type: 'model/gltf-binary' });
      setModelLoadProgress(`Building meshes · ${model.system} · ${index + 1} of ${models.length}`);
      const parsed = await parseModel([file]);
      const root = parsed.gltf.scene;
      root.name = model.system;
      setModelLoadProgress(`Applying materials · ${model.system} · ${index + 1} of ${models.length}`);
      const heart = isHeartModelId(model.id);
      const textureVariant = modelQuality(model);
      await applySourceMaterials(root, { heart, textureVariant });
      loaded.push({
        model,
        root,
        modelFileBytes: blob.size,
        textureBytes: getAppliedTextureBytes(root, { heart, textureVariant }),
        animations: isHeartLibraryModel(model) ? parsed.gltf.animations || [] : [],
        blobUrls: parsed.blobUrls,
      });
      setModelLoadProgress(`Prepared ${index + 1} of ${models.length} · ${model.system}`, ((index + 1) / models.length) * 100);
    }
    const combined = new THREE.Group();
    combined.name = models.length === 1 ? models[0].system : 'Combined anatomy systems';
    loaded.forEach(({ root }) => combined.add(root));
    const heartModel = loaded.find(({ model }) => isHeartLibraryModel(model));
    const displayName = loaded.map(({ model }) => model.label).join(' + ');
    setModelLoadProgress('Combining structures and fitting the scene…');
    await installLoadedScene({
      root: combined,
      displayName,
      catalogModels: models,
      modelCount: models.length,
      animations: heartModel?.animations || [],
      heartRoot: heartModel?.root || null,
      heartModelId: heartModel?.model.id || '',
      blobUrls: loaded.flatMap(({ blobUrls }) => blobUrls),
      modelFileBytes: loaded.reduce((total, entry) => total + entry.modelFileBytes, 0),
      textureBytes: loaded.reduce((total, entry) => total + entry.textureBytes, 0),
      loadNotice: usedCompatibleQualityFallback
        ? `Loaded original geometry where this browser could not decode a compressed quality variant.`
        : '',
    });
    restoreViewerPose(viewerPose);
    return true;
  } catch (error) {
    setStatus('Could not load selected models');
    showToast(error?.message || 'The selected offline models could not be loaded.', 'error');
    clearModelLoadProgress();
    return false;
  } finally {
    clearModelLoadProgress();
    ui.libraryLoad.disabled = false;
    ui.emptyModelLoad.disabled = false;
  }
}

async function appendLibraryModelsToScene(models) {
  if (!loadedRoot || !modelGroup || ui.libraryLoad.disabled) return false;
  const additions = models.filter((model) => !loadedLibraryModels.some((loaded) => loaded.id === model.id));
  if (!additions.length) return true;
  ui.libraryLoad.disabled = true;
  ui.emptyModelLoad.disabled = true;
  const prepared = [];
  let usedCompatibleQualityFallback = false;
  try {
    for (const [index, model] of additions.entries()) {
      const assetModel = compatibleLibraryModelAsset(model);
      usedCompatibleQualityFallback ||= assetModel.file !== model.file;
      setStatus(`Adding ${model.label} (${index + 1}/${additions.length})…`);
      setModelLoadProgress(`Downloading ${model.system} · ${index + 1} of ${additions.length}`, (index / additions.length) * 100);
      const blob = await fetchECGSupportModelBlob(assetModel, (fraction) => {
        setModelLoadProgress(
          `Downloading ${model.system} · ${index + 1} of ${additions.length}`,
          fraction === null ? null : ((index + fraction * 0.7) / additions.length) * 100,
        );
      });
      const file = new File([blob], `${model.id}.glb`, { type: 'model/gltf-binary' });
      setModelLoadProgress(`Building meshes · ${model.system} · ${index + 1} of ${additions.length}`);
      const parsed = await parseModel([file]);
      const root = parsed.gltf.scene;
      root.name = model.system;
      setModelLoadProgress(`Applying materials · ${model.system} · ${index + 1} of ${additions.length}`);
      const heart = isHeartModelId(model.id);
      const textureVariant = modelQuality(model);
      await applySourceMaterials(root, { heart, textureVariant });
      prepared.push({
        model,
        root,
        blobUrls: parsed.blobUrls,
        modelFileBytes: blob.size,
        textureBytes: getAppliedTextureBytes(root, { heart, textureVariant }),
      });
    }

    for (const { root } of prepared) {
      loadedRoot.add(root);
      freezeStaticModelTransforms(root);
    }
    refreshViewerBounds();
    updateCameraClipping();
    invalidateVisibleStructureMeshes();
    loadedLibraryModels = [...loadedLibraryModels, ...prepared.map(({ model }) => model)];
    loadedModelFileBytes += prepared.reduce((total, entry) => total + entry.modelFileBytes, 0);
    loadedTextureBytes += prepared.reduce((total, entry) => total + entry.textureBytes, 0);
    modelGroup.userData.blobUrls ||= [];
    modelGroup.userData.blobUrls.push(...prepared.flatMap(({ blobUrls }) => blobUrls));
    allNodes = collectNodes(loadedRoot);
    nodeMap = new Map(allNodes.map((entry) => [entry.id, entry.object]));
    for (const entry of allNodes) {
      if (!entry.isMesh && entry.object.children.length) collapsedGroups.add(entry.id);
    }
    const displayName = loadedLibraryModels.map((model) => model.label).join(' + ');
    modelFileName = displayName;
    ui.modelTitle.textContent = displayName;
    ui.source.textContent = displayName;
    const facts = countMeshFacts(loadedRoot);
    ui.meshSummary.textContent = `${facts.meshes.toLocaleString()} meshes · ${facts.triangles.toLocaleString()} triangles · Model ${formatFileSize(loadedModelFileBytes)} · Textures ${formatFileSize(loadedTextureBytes)}`;
    renderTree(ui.search.value);
    if (selectedNode) updateInspector(selectedNode);
    setStatus(`${loadedLibraryModels.length} models loaded`);
    showToast(usedCompatibleQualityFallback
      ? 'Loaded original geometry where this browser could not decode a compressed quality variant.'
      : `Added ${additions.map((model) => model.system).join(' and ')} for ECG placement.`);
    requestRender();
    return true;
  } catch (error) {
    for (const { root, blobUrls } of prepared) {
      root.traverse((object) => {
        object.geometry?.dispose?.();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((material) => material?.dispose?.());
      });
      blobUrls.forEach(URL.revokeObjectURL);
    }
    showToast(error?.message || 'The ECG support models could not be added.', 'error');
    setStatus('Could not add ECG support models');
    return false;
  } finally {
    clearModelLoadProgress();
    ui.libraryLoad.disabled = false;
    ui.emptyModelLoad.disabled = false;
  }
}

async function loadBundledHeart() {
  try {
    const response = await fetch('/models/heart.glb');
    if (!response.ok) return;
    const blob = await response.blob();
    await loadFiles([new File([blob], 'heart.glb', { type: 'model/gltf-binary' })], { displayName: 'Male · Heart', catalogId: 'male-2024-heart' });
  } catch {
    // The model file is optional; the workspace remains ready for a local import.
  }
}

function renderLibrarySexOptions() {
  const selection = librarySelectionsBySex.get(selectedLibrarySex);
  syncModelSelectionForQuality(selectedLibrarySex);
  const models = visibleLibraryModels(selectedLibrarySex);
  ui.library.replaceChildren();
  ui.library.setAttribute('aria-label', `Choose ${selectedLibrarySex.toLowerCase()} anatomy systems`);
  for (const model of models) {
    const label = document.createElement('label');
    label.className = 'library-option';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = model.id;
    checkbox.checked = selection.has(model.id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selection.add(model.id);
      else selection.delete(model.id);
    });
    const name = document.createElement('span');
    name.textContent = isHeartLibraryModel(model) ? 'Heart' : model.system;
    label.append(checkbox, name);
    ui.library.append(label);
  }
}

function renderEmptyModelOptions() {
  const previous = emptyModelSelectionBySex.get(selectedLibrarySex);
  const models = visibleLibraryModels(selectedLibrarySex);
  ui.emptyModelPicker.replaceChildren();
  const emptyOption = document.createElement('option');
  emptyOption.value = '';
  emptyOption.textContent = 'Choose a model';
  ui.emptyModelPicker.append(emptyOption);
  for (const model of models) {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = `${selectedLibrarySex} · ${isHeartLibraryModel(model) ? 'Heart' : model.system}`;
    ui.emptyModelPicker.append(option);
  }
  const selected = models.some((model) => model.id === previous)
    ? previous
    : models.find((model) => model.system === 'Heart')?.id || '';
  emptyModelSelectionBySex.set(selectedLibrarySex, selected);
  ui.emptyModelPicker.value = selected;
}

function setLibrarySex(sex) {
  if (!['Male', 'Female'].includes(sex)) return;
  selectedLibrarySex = sex;
  el('model-sex-male').setAttribute('aria-pressed', String(sex === 'Male'));
  el('model-sex-female').setAttribute('aria-pressed', String(sex === 'Female'));
  renderModelQualityControl();
  renderLibrarySexOptions();
  renderEmptyModelOptions();
}

async function loadModelLibrary() {
  try {
    const response = await fetch('/models/catalog.json');
    if (!response.ok) throw new Error('Offline model catalog is unavailable.');
    const data = await response.json();
    libraryModels = Array.isArray(data.models) ? data.models : [];
    renderModelQualityControl();
    renderLibrarySexOptions();
    renderEmptyModelOptions();
    ui.library.setAttribute('aria-busy', 'false');
  } catch (error) {
    const message = document.createElement('p');
    message.className = 'library-loading';
    message.textContent = 'Bundled library unavailable';
    ui.library.replaceChildren(message);
    setStatus(error.message || 'Offline model library unavailable');
  }
}

let detailedModelCatalog = [];
let detailedCatalogPromise;
const detailedGallery = el('detailed-gallery');
const detailedGrid = el('detailed-model-grid');
function renderDetailedModels(query = '') {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const models = detailedModelCatalog.filter((model) => (model.displayTitle || model.title).toLocaleLowerCase().includes(normalizedQuery));
  detailedGrid.replaceChildren();
  el('detailed-model-count').textContent = `${models.length} of ${detailedModelCatalog.length} models`;
  if (!models.length) {
    const empty = document.createElement('p');
    empty.className = 'detailed-empty';
    empty.textContent = 'No detailed models match that search.';
    detailedGrid.append(empty);
    return;
  }
  for (const model of models) {
    const card = document.createElement('article');
    card.className = 'detailed-card';
    const imageWrap = document.createElement('div');
    imageWrap.className = 'detailed-card-image';
    const image = document.createElement('img');
    image.src = model.thumbnail;
    image.alt = '';
    image.loading = 'lazy';
    imageWrap.append(image);
    const body = document.createElement('div');
    body.className = 'detailed-card-body';
    const title = document.createElement('h2');
    title.textContent = model.displayTitle || model.title;
    body.append(title);
    const structures = Array.isArray(model.structures) ? model.structures : [];
    if (structures.length) {
      const parts = document.createElement('details');
      parts.className = 'detailed-card-structures';
      const summary = document.createElement('summary');
      summary.textContent = `${structures.length} labeled parts`;
      const list = document.createElement('ul');
      for (const structure of structures) {
        const item = document.createElement('li');
        item.textContent = structure.name || 'Unnamed structure';
        list.append(item);
      }
      parts.append(summary, list);
      body.append(parts);
    }
    const status = document.createElement('p');
    const availableTextureCount = Array.isArray(model.textureBuffersAvailable)
      ? model.textureBuffersAvailable.length
      : 0;
    status.className = `detailed-card-status${model.geometryAvailable || model.texturesAvailable ? ' available' : ''}`;
    if (model.platformComplete && model.platform === 'macOS') {
      status.textContent = 'Mesh and macOS texture recovered · browser color and alpha maps ready';
    } else if (model.geometryAvailable && availableTextureCount) {
      status.textContent = `Geometry and ${availableTextureCount} texture payload${availableTextureCount === 1 ? '' : 's'} recovered · original app materials`;
    } else if (model.geometryAvailable) {
      status.textContent = 'Geometry recovered · no texture payloads recovered';
    } else if (availableTextureCount) {
      status.textContent = `${availableTextureCount} texture payload${availableTextureCount === 1 ? '' : 's'} recovered · geometry unavailable`;
    } else {
      status.textContent = 'App metadata and thumbnail available · model files not cached';
    }
    body.append(status);
    const action = document.createElement('button');
    action.className = 'detailed-card-action';
    action.type = 'button';
    action.disabled = !model.geometryAvailable;
    action.textContent = model.geometryAvailable ? 'Open textured model' : 'Model data unavailable';
    if (model.geometryAvailable) action.addEventListener('click', () => loadDetailedModel(model, action));
    body.append(action);
    card.append(imageWrap, body);
    detailedGrid.append(card);
  }
}
async function openDetailedGallery() {
  if (!detailedCatalogPromise) {
    detailedCatalogPromise = fetch('/models/detailed/catalog.json').then((response) => {
      if (!response.ok) throw new Error('Detailed model catalog could not be loaded.');
      return response.json();
    }).then((data) => {
      detailedModelCatalog = Array.isArray(data.models) ? data.models : [];
      el('open-detailed-models').querySelector('.detailed-model-count').textContent = detailedModelCatalog.length;
      return detailedModelCatalog;
    });
  }
  try {
    await detailedCatalogPromise;
    renderDetailedModels(el('detailed-search').value);
    detailedGallery.hidden = false;
    el('detailed-search').focus();
  } catch (error) {
    showToast(error.message || 'Detailed model library unavailable', 'error');
  }
}
function closeDetailedGallery() {
  detailedGallery.hidden = true;
  el('open-detailed-models').focus();
}
async function loadDetailedModel(model, button) {
  button.disabled = true;
  button.textContent = 'Preparing preview…';
  try {
    const previewUrl = new URL(model.previewFile, window.location.origin);
    const response = await fetch(previewUrl);
    if (!response.ok) throw new Error(`Could not open ${model.displayTitle || model.title}.`);
    const previewBlob = await response.blob();
    const previewFile = new File([previewBlob], 'preview.gltf', { type: 'model/gltf+json' });
    const gltf = JSON.parse(await previewBlob.text());
    const buffers = await Promise.all((gltf.buffers || []).map(async (buffer) => {
      const bufferUrl = new URL(buffer.uri, previewUrl);
      const bufferResponse = await fetch(bufferUrl);
      if (!bufferResponse.ok) throw new Error(`A geometry buffer for ${model.displayTitle || model.title} is missing.`);
      return new File([await bufferResponse.arrayBuffer()], buffer.uri.split('/').at(-1));
    }));
    const images = await Promise.all((gltf.images || []).filter((image) => image.uri).map(async (image) => {
      const imageUrl = new URL(image.uri, previewUrl);
      const imageResponse = await fetch(imageUrl);
      if (!imageResponse.ok) throw new Error(`A texture for ${model.displayTitle || model.title} is missing.`);
      return new File([await imageResponse.arrayBuffer()], image.uri.split('/').at(-1), { type: image.mimeType || 'image/png' });
    }));
    closeDetailedGallery();
    await loadFiles([previewFile, ...buffers, ...images], {
      displayName: `Detailed · ${model.displayTitle || model.title}`,
      textureBytes: images.reduce((total, image) => total + image.size, 0),
    });
  } catch (error) {
    showToast(error.message || `Could not load ${model.displayTitle || model.title}.`, 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Open textured model';
  }
}
el('open-detailed-models').addEventListener('click', openDetailedGallery);
el('close-detailed-models').addEventListener('click', closeDetailedGallery);
el('detailed-search').addEventListener('input', (event) => renderDetailedModels(event.currentTarget.value));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !detailedGallery.hidden) closeDetailedGallery();
});

function resize() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  requestRender();
}

function render(frameTime = performance.now()) {
  renderRequest = 0;
  if (document.hidden) return;
  // Avoid spending GPU time above display-useful rates on 90/120/144 Hz
  // displays. Low-power mode cuts animated scenes to 30 fps as well.
  const minimumFrameInterval = 1000 / (lowPowerMode ? 30 : 60);
  if (frameTime - previousRenderTime < minimumFrameInterval - 0.5) {
    requestRender();
    return;
  }
  previousRenderTime = frameTime;
  fpsWindowFrames += 1;
  if (!fpsWindowStart) fpsWindowStart = frameTime;
  const fpsWindowDuration = frameTime - fpsWindowStart;
  if (fpsWindowDuration >= 500) {
    const framesPerSecond = Math.round((fpsWindowFrames - 1) * 1000 / fpsWindowDuration);
    ui.fps.textContent = `${framesPerSecond} FPS`;
    ui.fps.dataset.rate = framesPerSecond < 20 ? 'low' : framesPerSecond < 40 ? 'medium' : 'high';
    fpsWindowStart = frameTime;
    fpsWindowFrames = 1;
  }
  controls.update();
  const delta = Math.min(Math.max((frameTime - previousFrameTime) / 1000, 0), 0.05);
  previousFrameTime = frameTime;
  if (animationPlaying) mixer?.update(delta);
  if (animationPlaying && ecgLeadOverlay?.visible) ecgLeadOverlay.userData.updateAnimatedSurfaceGuides?.(frameTime);
  updateConductionOverlay(delta);
  updateSelectionHighlight();
  renderer.render(scene, camera);
  const overlayUsesWallClock = !animationAction && depolarizationShell?.visible;
  if (animationPlaying || overlayUsesWallClock) requestRender();
}

controls.addEventListener('change', () => {
  updateCameraClipping();
  requestRender();
});

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const structureRaycastHits = [];
let pointerStart = null;
let visibleStructureMeshes = [];
let visibleStructureMeshesDirty = true;
function invalidateVisibleStructureMeshes() {
  visibleStructureMeshesDirty = true;
}

function getVisibleStructureMeshes() {
  if (!visibleStructureMeshesDirty) return visibleStructureMeshes;
  visibleStructureMeshes = [];
  visibleStructureMeshesDirty = false;
  if (!loadedRoot) return visibleStructureMeshes;
  loadedRoot.traverseVisible((object) => {
    if (!(object.isMesh || object.isSkinnedMesh || object.isInstancedMesh)) return;
    for (let parent = object; parent && parent !== loadedRoot; parent = parent.parent) {
      if (parent.userData?.excludeFromDepolarizationShell) return;
    }
    visibleStructureMeshes.push(object);
  });
  return visibleStructureMeshes;
}

function findNearestStructureHit() {
  let nearestHit = null;
  const originalFar = raycaster.far;
  let nearestDistance = originalFar;
  try {
    for (const object of getVisibleStructureMeshes()) {
      if (!raycaster.layers.test(object.layers)) continue;
      structureRaycastHits.length = 0;
      object.raycast(raycaster, structureRaycastHits);
      for (const hit of structureRaycastHits) {
        if (hit.distance < raycaster.near || hit.distance > nearestDistance || (nearestHit && hit.distance === nearestDistance)) continue;
        nearestHit = hit;
        nearestDistance = hit.distance;
      }
      // Mesh raycasts use far to reject triangles whose bounding sphere cannot
      // beat the current closest hit, so later objects do less triangle work.
      if (nearestHit) raycaster.far = nearestDistance;
    }
  } finally {
    raycaster.far = originalFar;
  }
  return nearestHit;
}

canvas.addEventListener('pointerdown', (event) => { pointerStart = { x: event.clientX, y: event.clientY }; });
canvas.addEventListener('pointerup', (event) => {
  if (!loadedRoot || !pointerStart) return;
  const moved = Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y);
  pointerStart = null;
  if (moved > 5) return;
  const rect = canvas.getBoundingClientRect();
  pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  if (ecgLeadOverlay?.visible) {
    const leadLabelHit = raycaster.intersectObject(ecgLeadOverlay, true)
      .find((hit) => hit.object.userData?.ecgLeadName);
    if (leadLabelHit) {
      selectECGLead(leadLabelHit.object.userData.ecgLeadName);
      return;
    }
  }
  const visibleHit = findNearestStructureHit();
  if (visibleHit) selectNode(visibleHit.object);
  else deselectNode();
});

ui.input.addEventListener('change', async () => { await loadFiles(ui.input.files); ui.input.value = ''; });
ui.libraryLoad.addEventListener('click', () => loadSelectedLibraryModels());
el('model-sex-male').addEventListener('click', () => setLibrarySex('Male'));
el('model-sex-female').addEventListener('click', () => setLibrarySex('Female'));
ui.modelQuality?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-model-quality]');
  if (button && !button.disabled) setModelQuality(button.dataset.modelQuality);
});
ui.emptyModelPicker.addEventListener('change', () => {
  emptyModelSelectionBySex.set(selectedLibrarySex, ui.emptyModelPicker.value);
});
ui.controlsMenuToggle.addEventListener('click', () => {
  const open = ui.controlsMenu.hidden;
  ui.controlsMenu.hidden = !open;
  ui.controlsMenuToggle.setAttribute('aria-expanded', String(open));
});
ui.controlsMenu.addEventListener('click', (event) => {
  if (event.target.closest('button:not(:disabled)')) {
    ui.controlsMenu.hidden = true;
    ui.controlsMenuToggle.setAttribute('aria-expanded', 'false');
  }
});
ui.lowPowerMode.setAttribute('aria-pressed', String(lowPowerMode));
ui.lowPowerMode.addEventListener('click', () => {
  lowPowerMode = !lowPowerMode;
  try { localStorage.setItem(LOW_POWER_MODE_STORAGE_KEY, String(lowPowerMode)); } catch { /* The setting remains active for this session. */ }
  applyLowPowerMode();
  showToast(lowPowerMode
    ? 'Low power rendering is on. Antialiasing updates after reload.'
    : 'Higher rendering resolution is on. Antialiasing updates after reload.');
});
ui.emptyModelLoad.addEventListener('click', () => {
  const selected = libraryModels.find((model) => model.id === ui.emptyModelPicker.value);
  if (selected) loadSelectedLibraryModels([selected]);
  else showToast('Choose an anatomy model first.', 'error');
});
ui.search.addEventListener('input', () => renderTree(ui.search.value));
el('fit-view').addEventListener('click', () => fitModel());
el('reset-view').addEventListener('click', resetCamera);
el('show-all').addEventListener('click', showAll);
el('focus-heart').addEventListener('click', focusHeart);
ui.conduction.addEventListener('click', async () => {
  const heartRoot = activeHeartRoot;
  if (!heartRoot) return;
  const overlay = await ensureConductionOverlay();
  if (!overlay || heartRoot !== activeHeartRoot) return;
  overlay.visible = !overlay.visible;
  const enabled = overlay.visible;
  if (enabled) {
    conductionElapsed = 0;
    overlay.userData.needsStaticUpdate = true;
  }
  ui.conduction.setAttribute('aria-pressed', String(enabled));
  requestRender();
});
ui.depolarization.addEventListener('click', async () => {
  const heartRoot = activeHeartRoot;
  if (!heartRoot) return;
  if (!depolarizationShell) {
    ui.depolarization.disabled = true;
    try {
      const overlay = await ensureConductionOverlay();
      if (!overlay || heartRoot !== activeHeartRoot) return;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (heartRoot !== activeHeartRoot) return;
      depolarizationShell = createDepolarizationShell(heartRoot);
      depolarizationShell.userData.needsStaticUpdate = true;
      modelGroup.add(depolarizationShell);
    } finally {
      ui.depolarization.disabled = !activeHeartRoot;
    }
  }
  if (heartRoot !== activeHeartRoot) return;
  depolarizationShell.visible = !depolarizationShell.visible;
  if (depolarizationShell.visible) depolarizationShell.userData.needsStaticUpdate = true;
  ui.depolarization.setAttribute('aria-pressed', String(depolarizationShell.visible));
  requestRender();
});
ui.ecg.addEventListener('click', async () => {
  const active = ui.ecg.getAttribute('aria-pressed') !== 'true';
  if (!active) {
    if (ecgLeadOverlay) ecgLeadOverlay.visible = false;
    setECGSupportVisibility(false);
    ui.ecg.setAttribute('aria-pressed', 'false');
    requestRender();
    return;
  }
  if (!activeHeartRoot) return;

  const heartRoot = activeHeartRoot;
  const heartModelId = activeHeartModelId;
  ui.ecg.disabled = true;
  try {
    if (!await ensureECGSupportModels()) return;
    if (heartRoot !== activeHeartRoot) return;
    if (!ecgLeadOverlay) {
      let ecgModel = null;
      try { ecgModel = await loadECGLandmarks(heartModelId); }
      catch (error) { console.warn('Using standard ECG lead axes without chest electrode markers.', error); }
      if (heartRoot !== activeHeartRoot) return;
      ecgLeadOverlay = createECGLeadOverlay(heartRoot, ecgModel);
      heartRoot.add(ecgLeadOverlay);
    }
    setECGSupportVisibility(true);

    const targetOverlay = ecgLeadOverlay;
    if (ecgTorsoContextEligible && !ecgTorsoContextPromise) {
      ecgTorsoContextPromise = loadECGTorsoContext(activeHeartModelId)
        .then((context) => {
          if (context && ecgLeadOverlay === targetOverlay) targetOverlay.add(context);
          return context;
        })
        .catch((error) => {
          ecgTorsoContextPromise = null;
          console.warn('ECG guides will use the model-registered positions without a torso surface context.', error);
          return null;
        });
      await ecgTorsoContextPromise;
    }

    if (ecgLeadOverlay) ecgLeadOverlay.visible = true;
    ui.ecg.setAttribute('aria-pressed', 'true');
    focusHeart({ frontView: true, distanceScale: 1.45 });
    requestRender();
  } finally {
    ui.ecg.disabled = !activeHeartRoot;
  }
});
ui.animation.addEventListener('click', () => {
  if (!animationAction) return;
  if (animationPlaying) {
    animationAction.paused = true;
    animationPlaying = false;
  } else {
    if (animationAction.paused) animationAction.paused = false;
    else animationAction.reset();
    animationAction.play();
    animationPlaying = true;
  }
  updateAnimationButton();
});
ui.isolate.addEventListener('click', () => selectedNode && setIsolate(selectedNode));
ui.toggle.addEventListener('click', () => {
  if (!selectedNode) return;
  selectedNode.visible = !selectedNode.visible;
  invalidateVisibleStructureMeshes();
  if (selectionBox) selectionBox.visible = selectedNode.visible;
  renderTree(ui.search.value);
  updateInspector(selectedNode);
});
const viewport = el('viewport-wrap');
viewport.addEventListener('dragover', (event) => { event.preventDefault(); viewport.classList.add('dragging'); });
viewport.addEventListener('dragleave', () => viewport.classList.remove('dragging'));
viewport.addEventListener('drop', async (event) => { event.preventDefault(); viewport.classList.remove('dragging'); await loadFiles(event.dataTransfer?.files); });
document.addEventListener('keydown', (event) => {
  if (event.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) { event.preventDefault(); ui.search.focus(); }
  if (event.key === 'Escape') { closeMobilePanels(); ui.search.value = ''; renderTree(''); if (selectedNode || selectedLead) deselectNode(); }
  if (event.key.toLowerCase() === 'r' && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) resetCamera();
});
const workspace = document.querySelector('.workspace');
for (const eventName of ['click', 'input', 'change', 'pointerup', 'keydown']) {
  workspace.addEventListener(eventName, requestRender);
}
const controlsMenuWrap = ui.controlsMenuToggle.parentElement;
document.addEventListener('pointerdown', (event) => {
  if (!controlsMenuWrap.contains(event.target)) {
    ui.controlsMenu.hidden = true;
    ui.controlsMenuToggle.setAttribute('aria-expanded', 'false');
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !ui.controlsMenu.hidden) {
    ui.controlsMenu.hidden = true;
    ui.controlsMenuToggle.setAttribute('aria-expanded', 'false');
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (renderRequest) cancelAnimationFrame(renderRequest);
    renderRequest = 0;
    return;
  }
  previousFrameTime = performance.now();
  requestRender();
});
function setSidebarCollapsed(side, collapsed) {
  const isLeft = side === 'left';
  const className = isLeft ? 'tree-collapsed' : 'inspector-collapsed';
  const button = el(isLeft ? 'collapse-left' : 'collapse-inspector');
  const panelName = isLeft ? 'model library' : 'inspector';
  workspace.classList.toggle(className, collapsed);
  button.title = `${collapsed ? 'Show' : 'Hide'} ${panelName}`;
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-expanded', String(!collapsed));
}
function closeMobilePanels() {
  const inspectorWasOpen = workspace.classList.contains('mobile-inspector-open');
  workspace.classList.remove('mobile-library-open', 'mobile-inspector-open');
  el('mobile-library-toggle').setAttribute('aria-expanded', 'false');
  el('mobile-inspector-toggle').setAttribute('aria-expanded', 'false');
  if (inspectorWasOpen) setSidebarCollapsed('right', true);
}
function openMobileInspectorPanel() {
  if (!window.matchMedia('(max-width: 860px)').matches) return;
  closeMobilePanels();
  setSidebarCollapsed('right', false);
  workspace.classList.add('mobile-inspector-open');
  el('mobile-inspector-toggle').setAttribute('aria-expanded', 'true');
}
el('mobile-library-toggle').addEventListener('click', () => {
  if (workspace.classList.contains('mobile-library-open')) {
    closeMobilePanels();
    return;
  }
  closeMobilePanels();
  workspace.classList.remove('tree-collapsed');
  workspace.classList.add('mobile-library-open');
  el('mobile-library-toggle').setAttribute('aria-expanded', 'true');
});
el('mobile-inspector-toggle').addEventListener('click', () => {
  if (workspace.classList.contains('mobile-inspector-open')) {
    closeMobilePanels();
    return;
  }
  closeMobilePanels();
  openMobileInspectorPanel();
});
workspace.addEventListener('click', (event) => {
  if (event.target === workspace && (workspace.classList.contains('mobile-library-open') || workspace.classList.contains('mobile-inspector-open'))) {
    closeMobilePanels();
  }
});
el('collapse-left').addEventListener('click', () => {
  if (window.matchMedia('(max-width: 560px)').matches) closeMobilePanels();
  else setSidebarCollapsed('left', !workspace.classList.contains('tree-collapsed'));
});
el('collapse-inspector').addEventListener('click', () => {
  if (window.matchMedia('(max-width: 860px)').matches) closeMobilePanels();
  else setSidebarCollapsed('right', !workspace.classList.contains('inspector-collapsed'));
});

const resizeObserver = new ResizeObserver(resize);
resizeObserver.observe(el('viewport-wrap'));

await loadModelLibrary();
try {
  wasm = await initWasm();
  setStatus('Ready for a local model');
} catch (error) {
  setStatus(error.message);
}
resize();
requestRender();
if (wasm) loadBundledHeart();
