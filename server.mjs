import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
const GOLBAT_URL = (process.env.GOLBAT_URL || '').trim().replace(/\/+$/, '');
const GOLBAT_SECRET = process.env.GOLBAT_SECRET || '';
const MAX_BODY_BYTES = 32 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(payload));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let content = '';
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body is too large.'));
        request.destroy();
        return;
      }
      content += chunk.toString('utf8');
    });
    request.on('end', () => {
      try { resolve(JSON.parse(content || '{}')); }
      catch { reject(new Error('Expected a JSON request body.')); }
    });
    request.on('error', reject);
  });
}

function clampNumber(value, min, max, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be between ${min} and ${max}.`);
  }
  return parsed;
}

function buildGolbatQuery(input) {
  const lat = clampNumber(input.latitude, -90, 90, 'Latitude');
  const lon = clampNumber(input.longitude, -180, 180, 'Longitude');
  const radiusKm = clampNumber(input.radiusKm, 0.1, 50, 'Radius');
  const limit = Math.max(1, Math.min(1000, Math.trunc(Number(input.limit) || 500)));
  const latitudeRadius = radiusKm / 110.574;
  const cosLatitude = Math.max(0.01, Math.abs(Math.cos(lat * Math.PI / 180)));
  const longitudeRadius = radiusKm / (111.320 * cosLatitude);

  const filter = {};
  if (input.speciesId !== null && input.speciesId !== undefined && input.speciesId !== '') {
    const speciesId = Math.trunc(clampNumber(input.speciesId, 1, 2000, 'Pokémon ID'));
    filter.pokemon = [{ id: speciesId }];
  }

  return {
    min: { lat: Math.max(-90, lat - latitudeRadius), lon: Math.max(-180, lon - longitudeRadius) },
    max: { lat: Math.min(90, lat + latitudeRadius), lon: Math.min(180, lon + longitudeRadius) },
    center: { lat, lon },
    limit,
    filters: [filter]
  };
}


let lastIFlowGoRequestAt = 0;
async function handleIFlowGo(request, response) {
  let input;
  try { input = await readJsonBody(request); }
  catch (error) { sendJson(response, 400, { error: error.message }); return; }

  let lat;
  let lon;
  let radiusKm;
  try {
    lat = clampNumber(input.latitude, -90, 90, 'Latitude');
    lon = clampNumber(input.longitude, -180, 180, 'Longitude');
    radiusKm = clampNumber(input.radiusKm, 0.1, 25, 'Radius');
  } catch (error) {
    sendJson(response, 400, { error: error.message });
    return;
  }

  // Gentle local rate limit so a click-happy UI does not hammer the third-party feed.
  const now = Date.now();
  if (now - lastIFlowGoRequestAt < 1500) {
    sendJson(response, 429, { error: 'Please wait a moment before querying the feed again.' });
    return;
  }
  lastIFlowGoRequestAt = now;

  const query = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    radius_km: String(radiusKm),
    layers: 'spawns',
    limit: String(Math.max(1, Math.min(800, Math.trunc(Number(input.limit) || 800))))
  });
  if (input.speciesId !== null && input.speciesId !== undefined && input.speciesId !== '') {
    try { query.set('pokemon_id', String(Math.trunc(clampNumber(input.speciesId, 1, 2000, 'Pokémon ID')))); }
    catch (error) { sendJson(response, 400, { error: error.message }); return; }
  }

  const endpoint = `https://pokecoords.iflowgo.com/iflowgopokecoords/api/v1/nearby?${query.toString()}`;
  try {
    const upstream = await fetch(endpoint, {
      method: 'GET',
      headers: { 'Accept': 'application/json', 'User-Agent': 'ShinyAtlasMapperResearch/1.0' },
      signal: AbortSignal.timeout(18000)
    });
    const raw = await upstream.text();
    let payload;
    try { payload = raw ? JSON.parse(raw) : {}; }
    catch { payload = { error: `iFlowGo returned non-JSON data (HTTP ${upstream.status}).`, detail: raw.slice(0, 500) }; }
    response.writeHead(upstream.status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    response.end(JSON.stringify(payload));
  } catch (error) {
    const isTimeout = error.name === 'TimeoutError' || error.name === 'AbortError';
    sendJson(response, 502, {
      error: isTimeout
        ? 'iFlowGo request timed out. Try a smaller radius or retry later.'
        : `Could not contact the iFlowGo feed: ${error.message || 'network error'}`
    });
  }
}

async function handleGolbat(request, response) {
  if (!GOLBAT_URL) {
    sendJson(response, 503, {
      error: 'Golbat is not configured. Set GOLBAT_URL and GOLBAT_SECRET in the environment, then restart server.mjs.'
    });
    return;
  }

  let input;
  try { input = await readJsonBody(request); }
  catch (error) { sendJson(response, 400, { error: error.message }); return; }

  let query;
  try { query = buildGolbatQuery(input); }
  catch (error) { sendJson(response, 400, { error: error.message }); return; }

  let target;
  try { target = new URL(`${GOLBAT_URL}/api/pokemon/v3/scan`); }
  catch { sendJson(response, 500, { error: 'GOLBAT_URL is not a valid URL.' }); return; }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    sendJson(response, 500, { error: 'GOLBAT_URL must use HTTP or HTTPS.' });
    return;
  }

  try {
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    if (GOLBAT_SECRET) headers['X-Golbat-Secret'] = GOLBAT_SECRET;
    const upstream = await fetch(target, {
      method: 'POST',
      headers,
      body: JSON.stringify(query),
      signal: AbortSignal.timeout(20000)
    });
    const text = await upstream.text();
    let payload;
    try { payload = text ? JSON.parse(text) : {}; }
    catch { payload = { error: `Golbat returned non-JSON data (HTTP ${upstream.status}).`, detail: text.slice(0, 500) }; }
    response.writeHead(upstream.status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    response.end(JSON.stringify(payload));
  } catch (error) {
    const isTimeout = error.name === 'TimeoutError' || error.name === 'AbortError';
    sendJson(response, 502, {
      error: isTimeout
        ? 'The mapper request timed out. Try a smaller radius or check the mapper server.'
        : `Could not contact Golbat: ${error.message || 'network error'}`
    });
  }
}

async function serveStatic(urlPath, response) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); }
  catch { sendJson(response, 400, { error: 'Invalid URL path.' }); return; }
  if (decoded === '/') decoded = '/index.html';
  const resolved = path.resolve(__dirname, `.${decoded}`);
  if (!resolved.startsWith(`${__dirname}${path.sep}`) && resolved !== path.join(__dirname, 'index.html')) {
    sendJson(response, 403, { error: 'Forbidden.' });
    return;
  }
  try {
    const fileStat = await stat(resolved);
    if (!fileStat.isFile()) throw new Error('Not a file');
    const content = await readFile(resolved);
    response.writeHead(200, {
      'Content-Type': MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self' https: http:; img-src 'self' data: https:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'"
    });
    response.end(content);
  } catch {
    sendJson(response, 404, { error: 'File not found.' });
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
  if (request.method === 'GET' && url.pathname === '/health') {
    sendJson(response, 200, { status: 'ok', golbatConfigured: Boolean(GOLBAT_URL) });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/iflowgo-nearby') {
    await handleIFlowGo(request, response);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/golbat-scan') {
    await handleGolbat(request, response);
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, { error: 'Method not allowed.' });
    return;
  }
  await serveStatic(url.pathname, response);
});

server.listen(PORT, HOST, () => {
  console.log(`Shiny Atlas running at http://${HOST}:${PORT}`);
  console.log(`Golbat proxy: ${GOLBAT_URL ? 'configured' : 'not configured (local file/JSON feed still available)'}`);
});
