import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import './style.css';

const el = (id) => document.getElementById(id);
const ui = {
  input: el('model-input'),
  library: el('model-library'),
  libraryLoad: el('load-library-models'),
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
  selectedId: el('selected-id'),
  selectedPath: el('selected-path'),
  geometry: el('property-geometry'),
  triangles: el('property-triangles'),
  materials: el('property-materials'),
  source: el('source-value'),
  isolate: el('isolate-selected'),
  toggle: el('toggle-selected'),
  toast: el('toast'),
  animation: el('toggle-animation'),
  conduction: el('toggle-conduction'),
  depolarization: el('toggle-depolarization'),
  ecg: el('toggle-ecg'),
};

const canvas = el('viewport');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
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
let loadedRoot = null;
let modelFileName = '';
let allNodes = [];
let selectedNode = null;
let selectionBox = null;
let selectionHighlightSources = [];
let toastTimer = 0;
let nodeMap = new Map();
let libraryModels = [];
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
let lastDepolarizationPhase = -1;
let previousFrameTime = performance.now();
const heartMaterials = new Map();
const originalHeartTextures = new Map();
let conductionNodeGeometryPromise;
let structureDescriptionsPromise;
let ecgLandmarksPromise;
const depolarizationResting = new THREE.Color('#167bd4');
const depolarizationActive = new THREE.Color('#ec253e');
const depolarizationFront = new THREE.Color('#ffe052');
// Approximate adult cardiac activation timing for this educational map.
// Calibrate model units to an adult heart height instead of assuming the GLB's scale.
const REFERENCE_HEART_HEIGHT_METERS = 0.12;
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
    const guide = new THREE.Mesh(
      new THREE.CylinderGeometry(guideRadius, guideRadius, delta.length(), 8),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.88, depthTest: false, depthWrite: false, toneMapped: false }),
    );
    guide.position.copy(start).add(end).multiplyScalar(0.5);
    guide.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
    guide.name = name;
    guide.renderOrder = 8;
    group.add(guide);
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
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
    sprite.position.copy(end);
    sprite.scale.set(labelHeight * 6.6, labelHeight * 3.3, 1);
    sprite.renderOrder = 9;
    group.add(sprite);
  };
  // In the heart-only scene, show the four limb electrode directions around
  // the myocardium as labeled schematic endpoints.
  const limbElectrodes = [
    ['RA', -0.82, 0.52, '#ffca58'],
    ['LA', 0.82, 0.52, '#44e2cf'],
    ['RL', -0.40, -0.82, '#ff7484'],
    ['LL', 0.40, -0.82, '#bd9bff'],
  ];
  for (const [name, xDirection, yDirection, color] of limbElectrodes) {
    const end = center.clone().add(new THREE.Vector3(xDirection * radius, yDirection * radius, 0));
    addGuide(center, end, color, `Schematic limb electrode guide ${name}`);
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(Math.max(labelHeight * 0.12, 0.012), 12, 8),
      new THREE.MeshBasicMaterial({ color, toneMapped: false, depthTest: false, depthWrite: false }),
    );
    marker.name = `Limb electrode ${name}`;
    marker.position.copy(end);
    marker.renderOrder = 10;
    group.add(marker);
    label(name, end.clone().add(new THREE.Vector3(Math.sign(xDirection) * labelHeight * 0.32, Math.sign(yDirection) * labelHeight * 0.2, 0)), 'limb', color);
  }

  const rootInverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const meshToRoot = new THREE.Matrix4();
  const vertex = new THREE.Vector3();
  const myocardialPositions = [];
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
    const position = object.geometry?.getAttribute('position');
    if (!position) return;
    meshToRoot.multiplyMatrices(rootInverse, object.matrixWorld);
    for (let i = 0; i < position.count; i += 1) {
      vertex.fromBufferAttribute(position, i).applyMatrix4(meshToRoot);
      myocardialPositions.push(vertex.x, vertex.y, vertex.z);
    }
  });
  for (const [name, point] of Object.entries(landmarks?.chestElectrodes || {})) {
    const end = new THREE.Vector3(...point);
    let nearest = center;
    let nearestDistance = Infinity;
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
    addGuide(nearest, end, 0xffd071, `Chest electrode guide ${name}`);
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(Math.max(labelHeight * 0.12, 0.012), 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xffdf9e, toneMapped: false, depthTest: false, depthWrite: false }),
    );
    marker.name = `Chest electrode ${name}`;
    marker.position.copy(end);
    marker.renderOrder = 9;
    group.add(marker);
    label(name, end, 'chest');
  }
  return group;
}

function createConductionOverlay(root, nodeModel = null) {
  root.updateWorldMatrix(true, true);
  const metersPerUnit = getModelMetersPerUnit(root);
  const group = new THREE.Group();
  group.name = 'Schematic cardiac conduction overlay';
  group.userData.excludeFromDepolarizationShell = true;
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
        const colors = new THREE.BufferAttribute(new Float32Array(position.count * 3), 3);
        clone.geometry.setAttribute('color', colors);
        clone.material = new THREE.MeshBasicMaterial({
          color: 0xffffff,
          vertexColors: true,
          transparent: true,
          opacity: 0.44,
          depthTest: true,
          depthWrite: false,
          side: THREE.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -1,
        });
        clone.renderOrder = 4;
        clone.castShadow = false;
        clone.receiveShadow = false;
        pairs.push({ source, clone, selected, colors, activationTimes, rootCoordinates, atrialTissue });
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
    const { activationTimes, rootCoordinates, atrialTissue } = pair;
    for (let i = 0; i < activationTimes.length; i += 1) {
      const offset = i * 3;
      activationTimes[i] = activationAt(
        rootCoordinates[offset], rootCoordinates[offset + 1], rootCoordinates[offset + 2], atrialTissue,
      );
    }
    delete pair.rootCoordinates;
  }
  depolarizationMeshPairs = pairs;
  return shellRoot;
}

function updateConductionOverlay(delta) {
  if (!conductionOverlay?.visible && !depolarizationShell?.visible) return;
  conductionElapsed += delta;
  const clipDuration = animationAction?.getClip().duration || 0;
  const cycleSeconds = clipDuration > 0
    ? clipDuration / Math.max(Math.abs(animationAction.timeScale), 0.001)
    : 1;
  const beatPhase = clipDuration > 0
    ? ((animationAction.time % clipDuration) + clipDuration) % clipDuration / clipDuration
    : (conductionElapsed % cycleSeconds) / cycleSeconds;
  loadedRoot.updateWorldMatrix(true, true);
  conductionOverlay?.userData.updateMorphFollowers?.();
  if (depolarizationShell?.visible) {
    const phaseDifference = Math.abs(beatPhase - lastDepolarizationPhase);
    const updateColors = lastDepolarizationPhase < 0 || Math.min(phaseDifference, 1 - phaseDifference) >= 0.015;
    const smooth = (value, low, high) => {
      const t = THREE.MathUtils.clamp((value - low) / (high - low), 0, 1);
      return t * t * (3 - 2 * t);
    };
    for (const { source, clone, selected, colors, activationTimes, atrialTissue } of depolarizationMeshPairs) {
      clone.position.copy(source.position);
      clone.quaternion.copy(source.quaternion);
      clone.scale.copy(source.scale);
      clone.visible = source.isMesh ? selected && source.visible : source.visible;
      if (source.morphTargetInfluences && clone.morphTargetInfluences) {
        clone.morphTargetInfluences.splice(0, clone.morphTargetInfluences.length, ...source.morphTargetInfluences);
      }
      clone.updateMatrix();
      if (selected && updateColors) {
        for (let i = 0; i < activationTimes.length; i += 1) {
          const offset = i * 3;
          if (!Number.isFinite(activationTimes[i])) {
            colors.array[offset] = depolarizationResting.r;
            colors.array[offset + 1] = depolarizationResting.g;
            colors.array[offset + 2] = depolarizationResting.b;
            continue;
          }
          let sinceActivation = beatPhase * cycleSeconds - activationTimes[i];
          sinceActivation = ((sinceActivation % cycleSeconds) + cycleSeconds) % cycleSeconds;
          const plateau = atrialTissue ? 0.12 : 0.20;
          const recovery = atrialTissue ? 0.06 : 0.08;
          const depolarized = 1 - smooth(sinceActivation, plateau, plateau + recovery);
          const wavefront = 1 - smooth(sinceActivation, 0.008, 0.020);
          const activeMix = depolarized * 0.86;
          const frontMix = wavefront * 0.92;
          const r = THREE.MathUtils.lerp(depolarizationResting.r, depolarizationActive.r, activeMix);
          const g = THREE.MathUtils.lerp(depolarizationResting.g, depolarizationActive.g, activeMix);
          const b = THREE.MathUtils.lerp(depolarizationResting.b, depolarizationActive.b, activeMix);
          colors.array[offset] = THREE.MathUtils.lerp(r, depolarizationFront.r, frontMix);
          colors.array[offset + 1] = THREE.MathUtils.lerp(g, depolarizationFront.g, frontMix);
          colors.array[offset + 2] = THREE.MathUtils.lerp(b, depolarizationFront.b, frontMix);
        }
        colors.needsUpdate = true;
      }
    }
    if (updateColors) lastDepolarizationPhase = beatPhase;
    depolarizationShell.updateWorldMatrix(true, true);
  }
  if (!conductionOverlay?.visible) return;
  for (const { line, anchors, updateAnchor } of conductionLines) {
    const positions = line.geometry.attributes.position;
    for (let i = 0; i < anchors.length; i += 1) positions.setXYZ(i, ...updateAnchor(anchors[i]).toArray());
    positions.needsUpdate = true;
    line.geometry.computeBoundingSphere();
  }
  for (const { node, updateAnchor } of conductionNodes) node.position.copy(updateAnchor(node.userData.anchor));
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
      const texture = await new THREE.TextureLoader().loadAsync(`/models/textures/${encodeURIComponent(filename)}`);
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

async function applyHeartMaterials(root) {
  const fillingTexture = await originalHeartTexture('filling_heart.png', THREE.SRGBColorSpace);
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
      if (!material) return getHeartMaterial(kind);
      const albedoName = material.userData?.formeOriginalAlbedoTexture;
      if (!albedoName) return getHeartMaterial(kind);
      return (async () => {
        const clone = material.clone();
        clone.opacity = material.userData?.formeOriginalOpacity ?? clone.opacity;
        clone.map = await originalHeartTexture(albedoName, THREE.SRGBColorSpace);
        const sourceIbl = heartEnvironment?.specular ? heartEnvironment : null;
        clone.envMap = sourceIbl ? null : heartEnvironment || null;
        const normalName = material.userData?.formeOriginalNormalTexture;
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
          shader.uniforms.formeSourceOverlayVisibility = { value: sourceRenderTuning.overlayVisibility };
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
          shader.fragmentShader = shader.fragmentShader.replace(
            '#include <map_fragment>',
            `#include <map_fragment>
             vec4 formeHeartFillingTexel = texture2D(formeHeartFillingMap, vMapUv);
             diffuseColor.rgb = mix(diffuseColor.rgb, formeHeartFillingTexel.rgb, formeSourceOverlayVisibility * formeHeartFillingTexel.a);`,
          );
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
        clone.customProgramCacheKey = () => 'forme-source-pbr-v2';
        const physicalSource = Object.assign({}, clone, {
          clearcoatNormalScale: new THREE.Vector2(1, 1),
          sheenColor: new THREE.Color(),
          attenuationColor: new THREE.Color(1, 1, 1),
          specularColor: new THREE.Color(1, 1, 1),
        });
        const glossy = new THREE.MeshPhysicalMaterial().copy(physicalSource);
        // Source shader derives dielectric F0 as 0.16 * reflectance^2.
        const f0 = 0.16 * sourceReflection * sourceReflection;
        const rootF0 = Math.sqrt(Math.max(0, Math.min(0.99, f0)));
        glossy.ior = (1 + rootF0) / (1 - rootF0);
        glossy.clearcoat = 0;
        glossy.roughness = material.roughness ?? 0.1;
        glossy.onBeforeCompile = sourceTone;
        glossy.customProgramCacheKey = () => 'forme-source-pbr-v2';
        glossy.needsUpdate = true;
        clone.dispose();
        material.dispose();
        return glossy;
      })();
    });
    replacements.push(Promise.all(next).then((materials) => {
      object.material = Array.isArray(object.material) ? materials : materials[0];
    }));
  });
  await Promise.all(replacements);
}

async function applyCatalogTextures(root) {
  const replacements = [];
  const originals = new Set();
  const replacementByMaterial = new WeakMap();
  root.traverse((object) => {
    if (!object.isMesh) return;
    const previous = Array.isArray(object.material) ? object.material : [object.material];
    const next = previous.map((material) => {
      if (!material) return material;
      const userData = material.userData || {};
      const albedoName = userData.formeOriginalAlbedoTexture;
      const normalName = userData.formeOriginalNormalTexture;
      if (!albedoName && !normalName) return material;
      let replacement = replacementByMaterial.get(material);
      if (!replacement) {
        originals.add(material);
        replacement = (async () => {
          const clone = material.clone();
          if (albedoName) clone.map = await originalHeartTexture(albedoName, THREE.SRGBColorSpace);
          if (normalName) {
            clone.normalMap = await originalHeartTexture(normalName, THREE.NoColorSpace);
            const scale = userData.formeOriginalNormalScale ?? 1;
            clone.normalScale.set(scale, scale);
          }
          clone.emissive?.set(0, 0, 0);
          clone.side = THREE.DoubleSide;
          clone.needsUpdate = true;
          return clone;
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
    source.updateWorldMatrix(true, false);
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
  clearSelectionHighlight();
  selectionBox = new THREE.Group();
  selectionBox.name = 'Selected mesh surface highlight';
  selectionBox.renderOrder = 10;
  scene.add(selectionBox);
  const material = new THREE.MeshBasicMaterial({
    color: 0xe48a7d,
    transparent: true,
    opacity: object.isMesh || object.isSkinnedMesh || object.isInstancedMesh ? 0.34 : 0.13,
    depthTest: !(object.isMesh || object.isSkinnedMesh || object.isInstancedMesh),
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
    overlay.frustumCulled = false;
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
}

function deselectNode() {
  selectedNode = null;
  clearSelectionHighlight();
  updateInspector(null);
  renderTree(ui.search.value);
}

function updateInspector(object) {
  if (!object) {
    ui.inspectorEmpty.hidden = false;
    ui.inspectorContent.hidden = true;
    ui.selectedCrumb.textContent = 'View';
    ui.hud.hidden = true;
    ui.isolate.disabled = true;
    ui.toggle.disabled = true;
    return;
  }
  ui.inspectorEmpty.hidden = true;
  ui.inspectorContent.hidden = false;
  const entry = allNodes.find((item) => item.object === object);
  const name = entry?.name || object.name || object.type;
  const facts = countMeshFacts(object);
  ui.selectedName.textContent = name;
  ui.selectedType.textContent = object.isMesh ? 'Mesh' : object.type;
  const sourceId = object.userData?.formeSourceId;
  ui.selectedId.textContent = sourceId ? `ID ${sourceId.slice(0, 8)}` : `#${object.id}`;
  ui.selectedId.title = sourceId || '';
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
  el('hud-triangles').textContent = `${facts.triangles.toLocaleString()} triangles`;
  ui.hud.hidden = false;
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
  controls.update();
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
  camera.near = 0.005;
  camera.far = 500;
  camera.updateProjectionMatrix();
  controls.minDistance = 0.12;
  controls.maxDistance = 35;
  controls.update();
  updateSelectionHighlight();
}

function showAll() {
  if (!loadedRoot) return;
  loadedRoot.traverse((object) => { object.visible = true; });
  renderTree(ui.search.value);
  if (selectedNode) updateInspector(selectedNode);
  showToast('All structures are visible.');
}

function setIsolate(object) {
  if (!loadedRoot) return;
  loadedRoot.traverse((part) => { part.visible = part === object || object.parent === part || isAncestor(object, part); });
  // Keep ancestors visible so the selected node remains attached to its scene.
  for (let parent = object.parent; parent; parent = parent.parent) parent.visible = true;
  renderTree(ui.search.value);
  updateInspector(object);
  showToast('Showing the selected structure.');
}

function isAncestor(ancestor, object) {
  for (let node = object.parent; node; node = node.parent) if (node === ancestor) return true;
  return false;
}

function focusHeart() {
  if (!loadedRoot) return;
  const heartTerms = /heart|cardiac|atri(?:um|a)|ventric(?:le|ular)|myocard|coronary|pericard/i;
  const matches = allNodes.filter((entry) => heartTerms.test(entry.name));
  if (!matches.length) {
    ui.search.value = 'heart';
    renderTree('heart');
    showToast('No heart-named structures found. Load a labeled heart model.', 'error');
    return;
  }

  const keep = new Set([loadedRoot]);
  for (const entry of matches) {
    for (let parent = entry.object; parent; parent = parent.parent) {
      keep.add(parent);
      if (parent === loadedRoot) break;
    }
    entry.object.traverse((part) => keep.add(part));
  }
  loadedRoot.traverse((object) => { object.visible = keep.has(object); });
  ui.search.value = '';
  renderTree('');

  const preferred = matches.find((entry) => /^heart$/i.test(entry.name))
    || matches.find((entry) => /heart|cardiac/i.test(entry.name) && !entry.isMesh)
    || matches.find((entry) => entry.isMesh)
    || matches[0];
  selectNode(preferred.object);
  fitModel(loadedRoot);
  updateInspector(preferred.object);
  showToast(`Showing ${matches.length} heart-related structures.`);
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
  const loader = new GLTFLoader(manager);
  try {
    const data = await modelFile.arrayBuffer();
    const gltf = await loader.parseAsync(data, '');
    return { gltf, modelFile, blobUrls };
  } catch (error) {
    blobUrls.forEach(URL.revokeObjectURL);
    throw error;
  }
}

async function installLoadedScene({ root, displayName = '', catalogId = '', modelCount = 1, animations = [], heartRoot = null, heartModelId = catalogId, blobUrls = [] } = {}) {
  clearSelectionHighlight();
  if (modelGroup?.userData.blobUrls) modelGroup.userData.blobUrls.forEach(URL.revokeObjectURL);
  if (mixer && loadedRoot) {
    mixer.stopAllAction();
    mixer.uncacheRoot(activeAnimationRoot || loadedRoot);
  }
  mixer = null;
  activeAnimationRoot = null;
  if (modelGroup) {
    scene.remove(modelGroup);
    modelGroup.traverse((object) => {
      object.geometry?.dispose?.();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => material?.dispose?.());
    });
  }
  animationAction = null;
  animationPlaying = false;
  conductionOverlay = null;
  ecgLeadOverlay = null;
  conductionLines = [];
  conductionNodes = [];
  conductionMorphFollowers = [];
  conductionMorphAnchors = [];
  depolarizationShell = null;
  depolarizationMeshPairs = [];
  lastDepolarizationPhase = -1;
  ui.conduction.disabled = true;
  ui.conduction.setAttribute('aria-pressed', 'false');
  ui.depolarization.disabled = true;
  ui.depolarization.setAttribute('aria-pressed', 'false');
  ui.ecg.disabled = true;
  ui.ecg.setAttribute('aria-pressed', 'false');
  modelGroup = new THREE.Group();
  modelGroup.name = 'Loaded anatomy fit';
  loadedRoot = root;
  modelGroup.add(loadedRoot);
  scene.add(modelGroup);
  const heartClip = animations.find((clip) => clip.name?.startsWith('Heart cycle'));
  const clip = heartClip || animations[0];
  if (heartRoot && clip) {
    mixer = new THREE.AnimationMixer(heartRoot);
    activeAnimationRoot = heartRoot;
    animationAction = mixer.clipAction(clip);
    if (heartClip) animationAction.timeScale = 30;
  }
  ui.animation.disabled = !animationAction;
  updateAnimationButton();
  modelFileName = displayName || 'Anatomy model';
  allNodes = collectNodes(loadedRoot);
  nodeMap = new Map(allNodes.map((entry) => [entry.id, entry.object]));
  collapsedGroups = new Set(allNodes.filter((entry) => !entry.isMesh && entry.object.children.length > 0).map((entry) => entry.id));
  selectedNode = null;
  updateInspector(null);
  fitModel(loadedRoot);
  if (heartRoot) {
    let nodeModel = null;
    try { nodeModel = await loadConductionNodeGeometry(heartModelId); }
    catch (error) { console.warn('Using schematic conduction node markers.', error); }
    let ecgModel = null;
    try { ecgModel = await loadECGLandmarks(heartModelId); }
    catch (error) { console.warn('Using standard ECG lead axes without chest electrode markers.', error); }
    conductionOverlay = createConductionOverlay(heartRoot, nodeModel);
    depolarizationShell = createDepolarizationShell(heartRoot);
    modelGroup.add(depolarizationShell);
    ecgLeadOverlay = createECGLeadOverlay(heartRoot, ecgModel);
    heartRoot.add(ecgLeadOverlay);
    ui.conduction.disabled = false;
    ui.depolarization.disabled = false;
    ui.ecg.disabled = false;
  }
  renderTree('');
  const facts = countMeshFacts(loadedRoot);
  ui.modelTitle.textContent = displayName;
  ui.source.textContent = displayName;
  if (catalogId) {
    const checkbox = Array.from(ui.library.querySelectorAll('input[type="checkbox"]'))
      .find((input) => input.value === catalogId);
    if (checkbox) checkbox.checked = true;
  }
  ui.meshSummary.textContent = `${facts.meshes.toLocaleString()} meshes · ${facts.triangles.toLocaleString()} triangles`;
  ui.emptyState.hidden = true;
  ui.isolate.disabled = true;
  ui.toggle.disabled = true;
  for (const id of ['fit-view', 'reset-view', 'show-all', 'export-image']) el(id).disabled = false;
  el('focus-heart').disabled = false;
  setStatus(`${modelCount} model${modelCount === 1 ? '' : 's'} loaded`);
  showToast(`Loaded ${displayName}.`);
  modelGroup.userData.blobUrls = blobUrls;
}

async function loadFiles(fileList, { displayName = '', catalogId = '' } = {}) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  try {
    const selectedFile = files.find((file) => /\.(glb|gltf)$/i.test(file.name));
    setModelLoadProgress(`Building meshes · ${selectedFile?.name || 'local model'}`);
    const { gltf, modelFile, blobUrls } = await parseModel(files);
    const heartRoot = catalogId.endsWith('-heart') ? gltf.scene : null;
    setModelLoadProgress(`Applying materials · ${displayName || modelFile.name}`);
    if (heartRoot) await applyHeartMaterials(heartRoot);
    else if (catalogId) await applyCatalogTextures(gltf.scene);
    await installLoadedScene({
      root: gltf.scene,
      displayName: displayName || modelFile.name,
      catalogId,
      animations: gltf.animations || [],
      heartRoot,
      heartModelId: heartRoot ? catalogId : '',
      blobUrls,
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

async function loadSelectedLibraryModels() {
  if (ui.libraryLoad.disabled) return;
  const models = selectedLibraryModels();
  if (!models.length) {
    showToast('Select one or more offline systems first.', 'error');
    return;
  }
  ui.libraryLoad.disabled = true;
  try {
    setStatus(`Loading ${models.length} offline model${models.length === 1 ? '' : 's'}…`);
    const loaded = [];
    for (const [index, model] of models.entries()) {
      setStatus(`Loading ${model.label} (${index + 1}/${models.length})…`);
      setModelLoadProgress(`Downloading ${model.system} · ${index + 1} of ${models.length}`, (index / models.length) * 100);
      const blob = await fetchModelBlob(`/models/${model.file}`, (fraction) => {
        setModelLoadProgress(
          `Downloading ${model.system} · ${index + 1} of ${models.length}`,
          fraction === null ? null : ((index + fraction * 0.7) / models.length) * 100,
        );
      }, model);
      const file = new File([blob], `${model.id}.glb`, { type: 'model/gltf-binary' });
      setModelLoadProgress(`Building meshes · ${model.system} · ${index + 1} of ${models.length}`);
      const parsed = await parseModel([file]);
      const root = parsed.gltf.scene;
      root.name = model.system;
      setModelLoadProgress(`Applying materials · ${model.system} · ${index + 1} of ${models.length}`);
      if (model.id.endsWith('-heart')) await applyHeartMaterials(root);
      else await applyCatalogTextures(root);
      loaded.push({
        model,
        root,
        animations: model.id.endsWith('-heart') ? parsed.gltf.animations || [] : [],
        blobUrls: parsed.blobUrls,
      });
      setModelLoadProgress(`Prepared ${index + 1} of ${models.length} · ${model.system}`, ((index + 1) / models.length) * 100);
    }
    const combined = new THREE.Group();
    combined.name = models.length === 1 ? models[0].system : 'Combined anatomy systems';
    loaded.forEach(({ root }) => combined.add(root));
    const heartModel = loaded.find(({ model }) => model.id.endsWith('-heart'));
    const displayName = loaded.map(({ model }) => model.label).join(' + ');
    setModelLoadProgress('Combining structures and fitting the scene…');
    await installLoadedScene({
      root: combined,
      displayName,
      modelCount: models.length,
      animations: heartModel?.animations || [],
      heartRoot: heartModel?.root || null,
      heartModelId: heartModel?.model.id || '',
      blobUrls: loaded.flatMap(({ blobUrls }) => blobUrls),
    });
  } catch (error) {
    setStatus('Could not load selected models');
    showToast(error?.message || 'The selected offline models could not be loaded.', 'error');
    clearModelLoadProgress();
  } finally {
    clearModelLoadProgress();
    ui.libraryLoad.disabled = false;
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

async function loadModelLibrary() {
  try {
    const response = await fetch('/models/catalog.json');
    if (!response.ok) throw new Error('Offline model catalog is unavailable.');
    const data = await response.json();
    libraryModels = Array.isArray(data.models) ? data.models : [];
    ui.library.replaceChildren();
    for (const modelName of [...new Set(libraryModels.map((model) => model.model))]) {
      const group = document.createElement('details');
      group.className = 'library-group';
      group.open = modelName === 'Male';
      const summary = document.createElement('summary');
      summary.className = 'library-group-summary';
      summary.textContent = modelName;
      group.append(summary);
      for (const model of libraryModels.filter((entry) => entry.model === modelName)) {
        const label = document.createElement('label');
        label.className = 'library-option';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = model.id;
        checkbox.checked = model.id === 'male-2024-heart';
        const name = document.createElement('span');
        name.textContent = model.system;
        label.append(checkbox, name);
        group.append(label);
      }
      ui.library.append(group);
    }
    ui.library.setAttribute('aria-busy', 'false');
  } catch (error) {
    const message = document.createElement('p');
    message.className = 'library-loading';
    message.textContent = 'Bundled library unavailable';
    ui.library.replaceChildren(message);
    setStatus(error.message || 'Offline model library unavailable');
  }
}

function resize() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function render(frameTime = performance.now()) {
  requestAnimationFrame(render);
  controls.update();
  const delta = Math.min(Math.max((frameTime - previousFrameTime) / 1000, 0), 0.05);
  previousFrameTime = frameTime;
  mixer?.update(delta);
  updateConductionOverlay(delta);
  updateSelectionHighlight();
  renderer.render(scene, camera);
}

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let pointerStart = null;
canvas.addEventListener('pointerdown', (event) => { pointerStart = { x: event.clientX, y: event.clientY }; });
canvas.addEventListener('pointerup', (event) => {
  if (!loadedRoot || !pointerStart) return;
  const moved = Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y);
  pointerStart = null;
  if (moved > 5) return;
  const rect = canvas.getBoundingClientRect();
  pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(loadedRoot, true);
  if (hits.length) selectNode(hits[0].object);
  else deselectNode();
});

for (const id of ['import-top', 'import-empty']) el(id).addEventListener('click', () => ui.input.click());
ui.input.addEventListener('change', async () => { await loadFiles(ui.input.files); ui.input.value = ''; });
ui.libraryLoad.addEventListener('click', loadSelectedLibraryModels);
ui.search.addEventListener('input', () => renderTree(ui.search.value));
el('fit-view').addEventListener('click', () => fitModel());
el('reset-view').addEventListener('click', resetCamera);
el('show-all').addEventListener('click', showAll);
el('focus-heart').addEventListener('click', focusHeart);
ui.conduction.addEventListener('click', () => {
  if (!conductionOverlay) return;
  conductionOverlay.visible = !conductionOverlay.visible;
  const enabled = conductionOverlay.visible;
  if (enabled) conductionElapsed = 0;
  ui.conduction.setAttribute('aria-pressed', String(enabled));
});
ui.depolarization.addEventListener('click', () => {
  if (!depolarizationShell) return;
  depolarizationShell.visible = !depolarizationShell.visible;
  lastDepolarizationPhase = -1;
  ui.depolarization.setAttribute('aria-pressed', String(depolarizationShell.visible));
});
ui.ecg.addEventListener('click', () => {
  if (!ecgLeadOverlay) return;
  const active = ui.ecg.getAttribute('aria-pressed') !== 'true';
  ecgLeadOverlay.visible = active;
  ui.ecg.setAttribute('aria-pressed', String(active));
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
  if (selectionBox) selectionBox.visible = selectedNode.visible;
  renderTree(ui.search.value);
  updateInspector(selectedNode);
});
el('export-image').addEventListener('click', () => {
  if (!loadedRoot) return;
  renderer.render(scene, camera);
  renderer.domElement.toBlob((blob) => {
    if (!blob) return showToast('The viewport image could not be saved.', 'error');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${modelFileName.replace(/\.[^.]+$/, '') || 'anatomy-view'}-view.png`;
    link.click();
    URL.revokeObjectURL(link.href);
    showToast('Viewport image saved.');
  }, 'image/png');
});

const viewport = el('viewport-wrap');
viewport.addEventListener('dragover', (event) => { event.preventDefault(); viewport.classList.add('dragging'); });
viewport.addEventListener('dragleave', () => viewport.classList.remove('dragging'));
viewport.addEventListener('drop', async (event) => { event.preventDefault(); viewport.classList.remove('dragging'); await loadFiles(event.dataTransfer?.files); });
document.addEventListener('keydown', (event) => {
  if (event.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) { event.preventDefault(); ui.search.focus(); }
  if (event.key === 'Escape') { ui.search.value = ''; renderTree(''); if (selectedNode) { selectedNode = null; clearSelectionHighlight(); updateInspector(null); renderTree(''); } }
  if (event.key.toLowerCase() === 'r' && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) resetCamera();
});
el('collapse-left').addEventListener('click', () => document.querySelector('.workspace').classList.toggle('tree-collapsed'));

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
render();
if (wasm) loadBundledHeart();
