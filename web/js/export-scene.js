// GLB and USDZ: files with the picture on the model, made by three.js's own exporters from a scene
// laid out for them: metres (a 10 cm model is 0.1 m, the size AR Quick Look shows it at), y up,
// and one mesh a material (the top with the picture, the walls, the bottom, the buildings): the
// USDZ exporter takes one material a mesh.

import * as THREE from '../vendor/three/three.module.js';
import { GLTFExporter } from '../vendor/three/addons/GLTFExporter.js';
import { USDZExporter } from '../vendor/three/addons/USDZExporter.js';
import { BOTTOM_COLOUR, BUILDING_COLOUR, SIDE_COLOUR, geometryOf } from './model-view.js';

// The part of a solid that one group of it covers, as a solid of its own: only the points it uses
// (each part with all the points of the solid would make the file three times as big).
export function part(mesh, group) {
  const remap = new Map();
  const indices = new Uint32Array(group.count);
  for (let k = 0; k < group.count; k++) {
    const old = mesh.indices[group.start + k];
    let id = remap.get(old);
    if (id === undefined) {
      id = remap.size;
      remap.set(old, id);
    }
    indices[k] = id;
  }
  const positions = new Float32Array(remap.size * 3);
  const uvs = mesh.uvs ? new Float32Array(remap.size * 2) : null;
  for (const [old, id] of remap) {
    positions.set(mesh.positions.subarray(old * 3, old * 3 + 3), id * 3);
    if (uvs) uvs.set(mesh.uvs.subarray(old * 2, old * 2 + 2), id * 2);
  }
  return { positions, uvs, indices };
}

export function exportScene(mesh, picture, buildings = null, title = 'model') {
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  root.name = title;
  root.scale.setScalar(0.001);           // millimetres to metres
  scene.add(root);
  const texture = new THREE.CanvasTexture(picture);
  texture.colorSpace = THREE.SRGBColorSpace;
  // JPEG, not PNG: a photo is a fifth of the size so, and the files stay small enough for AR Quick Look
  texture.userData.mimeType = 'image/jpeg';
  const materials = [
    new THREE.MeshStandardMaterial({ name: 'top', map: texture, roughness: 0.93, metalness: 0 }),
    new THREE.MeshStandardMaterial({ name: 'side', color: SIDE_COLOUR, roughness: 1, metalness: 0 }),
    new THREE.MeshStandardMaterial({ name: 'bottom', color: BOTTOM_COLOUR, roughness: 1, metalness: 0 }),
  ];
  for (const group of mesh.groups) {
    const piece = new THREE.Mesh(geometryOf(part(mesh, group)), materials[group.materialIndex]);
    piece.name = materials[group.materialIndex].name;
    root.add(piece);
  }
  if (buildings) {
    const houses = new THREE.Mesh(geometryOf(buildings), new THREE.MeshStandardMaterial({ name: 'buildings', color: BUILDING_COLOUR, roughness: 0.85, metalness: 0 }));
    houses.name = 'buildings';
    root.add(houses);
  }
  return scene;
}

export async function glbOf(scene) {
  const data = await new GLTFExporter().parseAsync(scene, { binary: true, maxTextureSize: 8192 });
  return new Uint8Array(data);
}

export async function usdzOf(scene) {
  return new USDZExporter().parseAsync(scene, {
    quickLookCompatible: true,
    maxTextureSize: 2048,
    ar: { anchoring: { type: 'plane' }, planeAnchoring: { alignment: 'horizontal' } },
  });
}
