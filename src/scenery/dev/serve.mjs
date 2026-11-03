#!/usr/bin/env node
// Dev only: tiny static file server with CORS for the synthetic OSM fixtures.
//   node src/scenery/dev/serve.mjs [rootDir] [port]
// Serves {root}/{z}/{x}/{y}.pbf as application/x-protobuf, 404 for missing tiles, a TileJSON at
// /planet (like https://tiles.openfreemap.org/planet) and 204 for /empty/... paths.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '/tmp/claude-0/-home-user-Flight-sim/7bee71d5-9f1f-55ef-9ffc-73df5cf9c113/scratchpad/osm-fixtures');
const port = Number(process.argv[3] ?? 8790);
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': '*' };

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (url.pathname === '/planet') {
    const body = JSON.stringify({ tilejson: '3.0.0', tiles: [`http://127.0.0.1:${port}/{z}/{x}/{y}.pbf`], minzoom: 0, maxzoom: 14, attribution: 'synthetic fixtures' });
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(body);
    return;
  }
  if (url.pathname.startsWith('/empty/')) { res.writeHead(204, cors); res.end(); return; }
  const path = normalize(join(root, decodeURIComponent(url.pathname)));
  if (!path.startsWith(root)) { res.writeHead(403, cors); res.end(); return; }
  try {
    const data = await readFile(path);
    res.writeHead(200, { ...cors, 'Content-Type': 'application/x-protobuf', 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    res.writeHead(404, { ...cors, 'Content-Type': 'text/plain' });
    res.end('no tile');
  }
});
server.listen(port, '127.0.0.1', () => console.log(`osm fixtures: http://127.0.0.1:${port}/{z}/{x}/{y}.pbf (root ${root})`));
