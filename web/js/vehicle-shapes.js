// Rockets and a space station, put on the model at their real size (asteroid-on-model.js places them,
// web/data/vehicles.json lists them). Two kinds:
//
//   glb     NASA's own models (Saturn V, the Space Shuttle, the ISS), through the server. The Shuttle's
//           and the station's geometry comes Draco-compressed: three.js reads it with its decoder in
//           JavaScript, run in a worker, as the page's CSP allows no WebAssembly. A model is turned as
//           the list says, parts that do not belong are dropped by name, and it is scaled so that its
//           height (or its longest extent) is the published one.
//   built   the rest, drawn here from published dimensions: bodies of revolution by their profile
//           ([height, radius] from the bottom up), boosters set round the core, an orbiter's wings
//           and fin as flat plates. A simple shape, its size exact.
//
// Every shape comes in metres, y up, standing on y = 0.

import * as THREE from '../vendor/three/three.module.js';
import { GLTFLoader } from '../vendor/three/addons/GLTFLoader.js';
import { DRACOLoader } from '../vendor/three/addons/DRACOLoader.js';

const SEGMENTS = 48;               // round a body of revolution is cut into
const DEG = Math.PI / 180;

export class VehicleShapes {
  // draco: the folder of the decoder's draco_decoder.js, as the page asks for it.
  constructor({ draco = 'vendor/three/draco/' } = {}) {
    this._draco = draco;
    this._gltf = null;             // made at the first model: the decoder's worker starts with it
  }

  // A built vehicle from its spec: a group of its parts.
  build(spec) {
    const group = new THREE.Group();
    for (const part of spec.parts) {
      const material = new THREE.MeshStandardMaterial({ color: part.colour, roughness: 0.55, metalness: 0.1 });
      if (part.profile) {
        for (const [x, z] of placesOf(part)) {
          const body = new THREE.Mesh(lathe(part.profile), material);
          body.position.set(x, 0, z);
          group.add(body);
        }
      } else if (part.plate) {
        group.add(plate(part.plate, material));
      }
    }
    group.updateMatrixWorld(true);
    return group;
  }

  // One of NASA's models, from the file the server gives: turned, its strays dropped, and scaled.
  async fromGlb(buffer, spec) {
    const gltf = await new Promise((resolve, reject) => this._loader().parse(buffer, '', resolve, reject));
    const model = gltf.scene;
    for (const name of spec.drop ?? []) model.getObjectByName(name)?.removeFromParent();
    const [x, y, z] = (spec.turnDeg ?? [0, 0, 0]).map((d) => d * DEG);
    model.rotation.set(x, y, z);
    const group = new THREE.Group();
    group.add(model);
    group.updateMatrixWorld(true);
    const size = new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3());
    const own = spec.fit === 'height' ? size.y : Math.max(size.x, size.y, size.z);
    if (!(own > 0)) throw new Error('The shape could not be read.');
    group.scale.setScalar((spec.fit === 'height' ? spec.heightM : spec.lengthM) / own);
    group.updateMatrixWorld(true);
    return group;
  }

  _loader() {
    if (!this._gltf) {
      const draco = new DRACOLoader();
      draco.setDecoderPath(this._draco);
      draco.setDecoderConfig({ type: 'js' });
      this._gltf = new GLTFLoader();
      this._gltf.setDRACOLoader(draco);
    }
    return this._gltf;
  }
}

// Where the copies of a part stand, [x, z] each: at its own place, or round the core.
export function placesOf(part) {
  const around = part.around;
  if (!around) return [part.at ?? [0, 0]];
  const angles = around.anglesDeg ?? Array.from({ length: around.count }, (_, k) => (around.turnDeg ?? 0) + 360 * k / around.count);
  return angles.map((a) => [around.radius * Math.cos(a * DEG), around.radius * Math.sin(a * DEG)]);
}

// A body of revolution round y from [height, radius] points, closed at its ends.
function lathe(profile) {
  const points = profile.map(([y, r]) => new THREE.Vector2(r, y));
  if (points[0].x > 0) points.unshift(new THREE.Vector2(0, points[0].y));
  if (points.at(-1).x > 0) points.push(new THREE.Vector2(0, points.at(-1).y));
  return new THREE.LatheGeometry(points, SEGMENTS);
}

// A flat plate (a wing, a fin): its outline [across, height] in the plane through the core's axis
// along x or along z, this thick, its middle at `at` [x, z].
function plate({ points, thickness, along, at = [0, 0] }, material) {
  const shape = new THREE.Shape(points.map(([u, y]) => new THREE.Vector2(u, y)));
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
  geometry.translate(0, 0, -thickness / 2);
  const mesh = new THREE.Mesh(geometry, material);
  if (along === 'z') mesh.rotation.y = -Math.PI / 2;          // the outline's across runs along z
  mesh.position.set(at[0], 0, at[1]);
  return mesh;
}
