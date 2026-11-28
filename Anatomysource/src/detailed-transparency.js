import * as THREE from 'three';

const transparencyLayer = 7;

// Accumulate weighted color and optical depth. Both sums are independent of
// draw order, including where triangles from the same mesh overlap.
function configureDetailedTransparency(material) {
  const opaquePass = { value: true };
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneFactor;
  const compile = material.onBeforeCompile;
  const programKey = material.customProgramCacheKey;
  material.onBeforeCompile = function (shader, renderer) {
    compile.call(this, shader, renderer);
    shader.uniforms.formeOpaquePass = opaquePass;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <dithering_fragment>',
      `#include <dithering_fragment>
       float alpha = clamp(gl_FragColor.a, 0.0, 1.0);
       // Some BLEND atlases also contain solid tissue. Let those pixels
       // occlude the translucent fragments behind them in the depth pass.
       if (formeOpaquePass) {
         if (alpha < 0.999) discard;
         gl_FragColor.a = 1.0;
         formeWeight = vec4(0.0);
         return;
       }
       if (alpha >= 0.999 || alpha <= 0.0) discard;
       float depth = 1.0 / gl_FragCoord.w;
       float weight = 1.0 / (0.01 + depth * depth);
       gl_FragColor = vec4(gl_FragColor.rgb * alpha * weight, -log(max(1.0 - alpha, 0.001)));
       // The composite recovers the sum of the RGB weights from a separate attachment.
       formeWeight = vec4(alpha * weight);`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      'void main() {',
      'uniform bool formeOpaquePass;\nlayout(location = 1) out highp vec4 formeWeight;\nvoid main() {',
    );
  };
  material.customProgramCacheKey = function () {
    return programKey.call(this) + '-detailed-transparency';
  };
  return opaquePass;
}

export function createDetailedTransparency(renderer) {
  if (!renderer.extensions.has('EXT_color_buffer_float')) return null;

  const depth = new THREE.DepthTexture(1, 1);
  const opaque = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    depthTexture: depth,
  });
  const accumulation = new THREE.WebGLRenderTarget(1, 1, {
    count: 2,
    type: THREE.HalfFloatType,
    depthTexture: depth,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
  });
  const composite = new THREE.Scene();
  const compositeCamera = new THREE.Camera();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    uniforms: {
      opaqueColor: { value: opaque.texture },
      accumulatedColor: { value: accumulation.textures[0] },
      accumulatedWeight: { value: accumulation.textures[1] },
    },
    vertexShader: `
      varying vec2 sampleUv;
      void main() {
        sampleUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }`,
    fragmentShader: `
      uniform sampler2D opaqueColor;
      uniform sampler2D accumulatedColor;
      uniform sampler2D accumulatedWeight;
      varying vec2 sampleUv;
      void main() {
        vec4 accum = texture2D(accumulatedColor, sampleUv);
        float weight = texture2D(accumulatedWeight, sampleUv).r;
        vec3 color = accum.rgb / max(weight, 0.00001);
        float opacity = 1.0 - exp(-accum.a);
        gl_FragColor = vec4(mix(texture2D(opaqueColor, sampleUv).rgb, color, opacity), 1.0);
        #include <colorspace_fragment>
      }`,
  }));
  quad.frustumCulled = false;
  composite.add(quad);
  const size = new THREE.Vector2();
  const clearColor = new THREE.Color();

  return {
    prepare(root) {
      const blended = new Map();
      root.traverse((object) => {
        // GLTFLoader creates a separate mesh for each primitive/material.
        if (!object.isMesh || !object.material?.transparent) return;
        object.layers.enable(transparencyLayer);
        if (blended.has(object.material)) return;
        blended.set(object.material, configureDetailedTransparency(object.material));
      });
      return blended;
    },
    render(scene, camera, blended) {
      renderer.getDrawingBufferSize(size);
      if (size.x < 1 || size.y < 1) return;
      opaque.setSize(size.x, size.y);
      accumulation.setSize(size.x, size.y);
      const mask = camera.layers.mask;
      const background = scene.background;
      const autoClear = renderer.autoClear;
      const clearAlpha = renderer.getClearAlpha();
      renderer.getClearColor(clearColor);
      renderer.setRenderTarget(opaque);
      blended.forEach((pass, material) => {
        pass.value = true;
        material.blending = THREE.NoBlending;
        material.depthWrite = true;
      });
      try {
        renderer.render(scene, camera);
        blended.forEach((pass, material) => {
          pass.value = false;
          material.blending = THREE.CustomBlending;
          material.depthWrite = false;
        });
        camera.layers.set(transparencyLayer);
        scene.background = null;
        renderer.autoClear = false;
        renderer.setRenderTarget(accumulation);
        renderer.setClearColor(0, 0);
        renderer.clearColor();
        renderer.render(scene, camera);
      } finally {
        camera.layers.mask = mask;
        scene.background = background;
        renderer.autoClear = autoClear;
        renderer.setClearColor(clearColor, clearAlpha);
        renderer.setRenderTarget(null);
      }
      renderer.render(composite, compositeCamera);
    },
  };
}
