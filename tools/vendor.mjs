// Copies the libraries the page carries from node_modules into web/vendor: three.js (the 3D view,
// GLB and USDZ export, zip) and Leaflet (the map). The page loads nothing from other sites, so these
// are files of our own; npm only says which version. After a version change: npm install, npm run
// vendor, and commit web/vendor.
//
// three's add-ons import 'three' by its bare name, which a browser resolves only through an import
// map, and an inline import map is a script the page's Content-Security-Policy refuses. So the copies
// import the files by path instead.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FROM = join(ROOT, 'node_modules');
const TO = join(ROOT, 'web', 'vendor');

const THREE_ADDONS = {
  'controls/OrbitControls.js': 'OrbitControls.js',
  'exporters/GLTFExporter.js': 'GLTFExporter.js',
  'exporters/USDZExporter.js': 'USDZExporter.js',
  'libs/fflate.module.js': 'fflate.module.js',
};

function copyAddon(from, to) {
  const source = readFileSync(join(FROM, 'three', 'examples', 'jsm', from), 'utf8')
    .replace(/from 'three';/g, "from '../three.module.js';")
    .replace(/from '\.\.\/libs\/fflate\.module\.js';/g, "from './fflate.module.js';");
  // the statements only: the add-ons' doc comments show the bare import as an example
  if (/^(?:import|\})[^\n]*from '(three['/]|\.\.\/(libs|utils|math)\/)/m.test(source)) {
    throw new Error(`${from}: an import is left that the page cannot resolve`);
  }
  writeFileSync(join(TO, 'three', 'addons', to), source);
}

rmSync(TO, { recursive: true, force: true });
mkdirSync(join(TO, 'three', 'addons'), { recursive: true });
for (const file of ['three.module.js', 'three.core.js']) cpSync(join(FROM, 'three', 'build', file), join(TO, 'three', file));
cpSync(join(FROM, 'three', 'LICENSE'), join(TO, 'three', 'LICENSE'));
for (const [from, to] of Object.entries(THREE_ADDONS)) copyAddon(from, to);

mkdirSync(join(TO, 'leaflet'), { recursive: true });
for (const file of ['leaflet-src.esm.js', 'leaflet.css']) cpSync(join(FROM, 'leaflet', 'dist', file), join(TO, 'leaflet', file));
cpSync(join(FROM, 'leaflet', 'dist', 'images'), join(TO, 'leaflet', 'images'), { recursive: true });
cpSync(join(FROM, 'leaflet', 'LICENSE'), join(TO, 'leaflet', 'LICENSE'));

const versions = Object.fromEntries(['three', 'leaflet'].map((name) =>
  [name, JSON.parse(readFileSync(join(FROM, name, 'package.json'), 'utf8')).version]));
writeFileSync(join(TO, 'VERSIONS.json'), JSON.stringify(versions, null, 2) + '\n');
console.log('web/vendor:', versions);
