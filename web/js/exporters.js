// Files of a model for printing and for other programs: STL, 3MF and OBJ. GLB and USDZ come from
// three.js's own exporters (export-scene.js): they need the scene with its pictures.
//
// A solid here is { positions, indices }: millimetres, x east, y north, z up, as terrain-mesh.js
// builds them (buildings come the same way). Plain functions on numbers: the tests check the bytes.

import { strToU8, zipSync } from '../vendor/three/addons/fflate.module.js';

const APP = 'Planet Terrain Maker';

function* triangles(solids) {
  for (const { positions, indices } of solids) {
    for (let k = 0; k < indices.length; k += 3) {
      yield [indices[k] * 3, indices[k + 1] * 3, indices[k + 2] * 3].map((o) => [positions[o], positions[o + 1], positions[o + 2]]);
    }
  }
}

function countTriangles(solids) {
  return solids.reduce((n, s) => n + s.indices.length / 3, 0);
}

// Binary STL: an 80-byte header, the count, then 50 bytes a triangle (normal, three corners, 0).
export function stlOf(solids, title = 'model') {
  const count = countTriangles(solids);
  const bytes = new Uint8Array(84 + 50 * count);
  const view = new DataView(bytes.buffer);
  bytes.set(strToU8(`${APP}: ${title}`.slice(0, 80)));
  view.setUint32(80, count, true);
  let at = 84;
  for (const [a, b, c] of triangles(solids)) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz) || 1;
    nx /= length; ny /= length; nz /= length;
    for (const value of [nx, ny, nz, ...a, ...b, ...c]) {
      view.setFloat32(at, value, true);
      at += 4;
    }
    at += 2;
  }
  return bytes;
}

// The solids as one mesh whose corners are shared: the same point is one vertex, however many
// triangles meet there. 3MF wants that (its slicers check that every edge has two triangles), and
// the walls and the top of a model have their own copies of the points they share. Triangles that
// shrink to a line in the weld are left out.
export function weld(solids, gridMm = 1e-4) {
  const index = new Map();
  const vertices = [];
  const faces = [];
  const id = ([x, y, z]) => {
    const key = `${Math.round(x / gridMm)},${Math.round(y / gridMm)},${Math.round(z / gridMm)}`;
    let k = index.get(key);
    if (k === undefined) {
      k = vertices.length / 3;
      index.set(key, k);
      vertices.push(x, y, z);
    }
    return k;
  };
  for (const [a, b, c] of triangles(solids)) {
    const ia = id(a), ib = id(b), ic = id(c);
    if (ia !== ib && ib !== ic && ia !== ic) faces.push(ia, ib, ic);
  }
  return { vertices: Float32Array.from(vertices), faces: Uint32Array.from(faces) };
}

const fixed = (n) => {
  const s = n.toFixed(4);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
};
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// A 3MF package (3MF core, millimetres): one object, the solids welded into one mesh.
export function threeMfOf(solids, title = 'model') {
  const { vertices, faces } = weld(solids);
  const parts = [
    '<?xml version="1.0" encoding="UTF-8"?>\n',
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n',
    ` <metadata name="Title">${xml(title)}</metadata>\n`,
    ` <metadata name="Application">${APP}</metadata>\n`,
    ' <resources>\n',
    `  <object id="1" type="model" name="${xml(title)}">\n   <mesh>\n    <vertices>\n`,
  ];
  for (let k = 0; k < vertices.length; k += 3) {
    parts.push(`     <vertex x="${fixed(vertices[k])}" y="${fixed(vertices[k + 1])}" z="${fixed(vertices[k + 2])}"/>\n`);
  }
  parts.push('    </vertices>\n    <triangles>\n');
  for (let k = 0; k < faces.length; k += 3) {
    parts.push(`     <triangle v1="${faces[k]}" v2="${faces[k + 1]}" v3="${faces[k + 2]}"/>\n`);
  }
  parts.push('    </triangles>\n   </mesh>\n  </object>\n </resources>\n <build>\n  <item objectid="1"/>\n </build>\n</model>\n');
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>'
      + '</Types>\n'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>'
      + '</Relationships>\n'),
    '3D/3dmodel.model': strToU8(parts.join('')),
  }, { level: 6 });
}

// An OBJ with its MTL and the picture of the top, in a zip. Y is up there (Blender and most
// programs take OBJ so); millimetres, as in the other files. `mesh` is the terrain as
// terrain-mesh.js builds it (with uvs and groups); `extra` are solids without a picture (buildings).
export function objZipOf(mesh, pictureJpeg, extra = [], title = 'model') {
  const lines = [`# ${APP}: ${title}`, 'mtllib model.mtl'];
  const p = mesh.positions, uv = mesh.uvs;
  for (let k = 0; k < p.length; k += 3) lines.push(`v ${fixed(p[k])} ${fixed(p[k + 2])} ${fixed(-p[k + 1])}`);
  for (let k = 0; k < uv.length; k += 2) lines.push(`vt ${fixed(uv[k])} ${fixed(uv[k + 1])}`);
  const names = ['top', 'side', 'bottom'];
  lines.push('o terrain');
  for (const { start, count, materialIndex } of mesh.groups) {
    lines.push(`usemtl ${names[materialIndex]}`);
    for (let k = start; k < start + count; k += 3) {
      const [a, b, c] = [mesh.indices[k] + 1, mesh.indices[k + 1] + 1, mesh.indices[k + 2] + 1];
      lines.push(materialIndex === 0 ? `f ${a}/${a} ${b}/${b} ${c}/${c}` : `f ${a} ${b} ${c}`);
    }
  }
  let offset = p.length / 3;
  extra.forEach((solid, n) => {
    lines.push(`o buildings${extra.length > 1 ? n + 1 : ''}`, 'usemtl buildings');
    const q = solid.positions;
    for (let k = 0; k < q.length; k += 3) lines.push(`v ${fixed(q[k])} ${fixed(q[k + 2])} ${fixed(-q[k + 1])}`);
    for (let k = 0; k < solid.indices.length; k += 3) {
      lines.push(`f ${solid.indices[k] + 1 + offset} ${solid.indices[k + 1] + 1 + offset} ${solid.indices[k + 2] + 1 + offset}`);
    }
    offset += q.length / 3;
  });
  const mtl = [
    'newmtl top', 'Kd 1 1 1', 'map_Kd picture.jpg', '',
    'newmtl side', 'Kd 0.42 0.38 0.34', '',
    'newmtl bottom', 'Kd 0.3 0.3 0.3', '',
    'newmtl buildings', 'Kd 0.9 0.88 0.84', '',
  ].join('\n');
  return zipSync({
    'model.obj': strToU8(lines.join('\n') + '\n'),
    'model.mtl': strToU8(mtl),
    'picture.jpg': [pictureJpeg, { level: 0 }],      // a JPEG does not shrink further
  }, { level: 6 });
}
