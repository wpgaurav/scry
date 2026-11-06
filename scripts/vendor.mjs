// Copies browser dependencies into public/vendor so the UI makes no CDN calls.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
const files = [
  ['node_modules/@tabler/core/dist/css/tabler.min.css', 'public/vendor/tabler.min.css'],
  ['node_modules/@tabler/core/dist/js/tabler.min.js', 'public/vendor/tabler.min.js'],
  ['node_modules/apexcharts/dist/apexcharts.min.js', 'public/vendor/apexcharts.min.js'],
];
mkdirSync('public/vendor', { recursive: true });
for (const [from, to] of files) if (existsSync(from)) copyFileSync(from, to);
