import * as THREE from 'three';
import { COLORS } from '../config';

/**
 * Matte clay material whose paint state comes from a per-mesh mask texture:
 *   R = paint coverage (scored), G = decorative paint (drips, droplets — not scored),
 *   B = wetness (brief shine after cleaning), A = baked ambient occlusion.
 */
export interface ClayUniforms {
  uMask: { value: THREE.Texture | null };
  uPaint: { value: THREE.Color };
  uWetTint: { value: THREE.Color };
  uMaskTexel: { value: THREE.Vector2 };
  uAo: { value: number };
}

const NOISE = /* glsl */ `
varying vec2 vMaskUv;
varying vec3 vWPos;
uniform sampler2D uMask;
uniform vec3 uPaint;
uniform vec3 uWetTint;
uniform vec2 uMaskTexel;
uniform float uAo;
float h31(vec3 p){ p = fract(p*0.3183099 + 0.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float vnoise(vec3 x){
  vec3 i = floor(x); vec3 f = fract(x); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(h31(i+vec3(0,0,0)),h31(i+vec3(1,0,0)),f.x),mix(h31(i+vec3(0,1,0)),h31(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(h31(i+vec3(0,0,1)),h31(i+vec3(1,0,1)),f.x),mix(h31(i+vec3(0,1,1)),h31(i+vec3(1,1,1)),f.x),f.y),f.z);
}
`;

export function createClayMaterial(color = COLORS.clay): THREE.MeshStandardMaterial & { userData: { uniforms: ClayUniforms } } {
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.92, metalness: 0 }) as THREE.MeshStandardMaterial & {
    userData: { uniforms: ClayUniforms };
  };
  const uniforms: ClayUniforms = {
    uMask: { value: null },
    uPaint: { value: new THREE.Color(COLORS.paint) },
    uWetTint: { value: new THREE.Color(0xbfefff) },
    uMaskTexel: { value: new THREE.Vector2(1, 1) },
    uAo: { value: 0 },
  };
  mat.userData.uniforms = uniforms;
  mat.customProgramCacheKey = () => 'clay-paint-v1';
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 maskUv;\nvarying vec2 vMaskUv;\nvarying vec3 vWPos;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvMaskUv = maskUv;\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + NOISE)
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
  vec4 mk = texture2D(uMask, vMaskUv);
  float cov = max(mk.r, mk.g);
  float nz = vnoise(vWPos * 9.0) * 0.55 + vnoise(vWPos * 24.0) * 0.3 + vnoise(vWPos * 70.0) * 0.15;
  float paintA = smoothstep(0.46, 0.54, cov + (nz - 0.5) * 0.36);
  float wet = mk.b * (1.0 - paintA);
  float bakedAo = mix(1.0, mix(0.35, 1.0, mk.a), uAo);
  diffuseColor.rgb = mix(diffuseColor.rgb, uPaint, paintA);
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * uWetTint, wet * 0.35);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `#include <roughnessmap_fragment>
  roughnessFactor = mix(roughnessFactor, 0.3, paintA);
  roughnessFactor = mix(roughnessFactor, 0.07, wet);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `#include <normal_fragment_maps>
  {
    // Raised paint: bump from the paint height (perturbNormalArb).
    float hgt = paintA * (0.6 + 0.4 * cov);
    vec3 vSigmaX = dFdx(-vViewPosition);
    vec3 vSigmaY = dFdy(-vViewPosition);
    vec3 R1 = cross(vSigmaY, normal);
    vec3 R2 = cross(normal, vSigmaX);
    float fDet = dot(vSigmaX, R1) * faceDirection;
    vec2 dHdxy = vec2(dFdx(hgt), dFdy(hgt)) * 0.55;
    vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
    normal = normalize(abs(fDet) * normal - vGrad);
  }`,
      )
      .replace(
        '#include <aomap_fragment>',
        /* glsl */ `#include <aomap_fragment>
  reflectedLight.indirectDiffuse *= bakedAo;
  reflectedLight.indirectSpecular *= mix(1.0, bakedAo, 0.7);
  reflectedLight.directDiffuse *= mix(1.0, bakedAo, 0.45);`,
      );
  };
  return mat;
}

/** Plain clay for non-paintable props (tools). */
export function plainClay(color: number, roughness = 0.85, metalness = 0): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}
