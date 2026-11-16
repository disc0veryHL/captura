// Copy map libraries from node_modules into public/vendor so the app works offline.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public', 'vendor');
fs.mkdirSync(out, { recursive: true });
const files = [
  ['node_modules/leaflet/dist/leaflet.js', 'leaflet.js'],
  ['node_modules/leaflet/dist/leaflet.css', 'leaflet.css'],
  ['node_modules/leaflet.markercluster/dist/leaflet.markercluster.js', 'leaflet.markercluster.js'],
  ['node_modules/leaflet.markercluster/dist/MarkerCluster.css', 'MarkerCluster.css'],
];
for (const [from, to] of files) fs.copyFileSync(path.join(root, from), path.join(out, to));
console.log('vendor files copied to', out);
