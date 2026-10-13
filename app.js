(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  const form = $('#search-form');
  const trainerCodeInput = $('#trainer-code');
  const playerIdInput = $('#player-id');
  const shinyOddsInput = $('#shiny-odds');
  const latitudeInput = $('#latitude');
  const longitudeInput = $('#longitude');
  const radiusInput = $('#radius');
  const speciesInput = $('#species-id');
  const feedUrlInput = $('#feed-url');
  const feedTokenInput = $('#feed-token');
  const fileInput = $('#spawn-file');
  const searchButton = $('#search-button');
  const buttonLabel = $('#button-label');
  const clearButton = $('#clear-button');
  const linkTrainerButton = $('#link-trainer-button');
  const formStatus = $('#form-status');
  const resultsSection = $('#results-section');
  const resultsTitle = $('#results-title');
  const resultCount = $('#result-count');
  const resultSource = $('#result-source');
  const recordsList = $('#records-list');
  const resultsNote = $('#results-note');
  const paginationRow = $('#pagination-row');
  const paginationLabel = $('#pagination-label');
  const showMoreButton = $('#show-more-button');

  let sourceMode = 'iflowgo';
  let loadedFileRows = null;
  let lastRecords = [];
  let shownCount = 0;
  const PAGE_SIZE = 40;

  function setStatus(message, type = '') {
    formStatus.textContent = message;
    formStatus.className = `inline-status${type ? ` ${type}` : ''}`;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[character]));
  }

  function canonicalKey(key) {
    return String(key ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  }

  function firstValue(object, keys) {
    for (const key of keys) {
      const value = object[key];
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return undefined;
  }

  function normalizeRecord(input) {
    const row = {};
    for (const [key, value] of Object.entries(input || {})) row[canonicalKey(key)] = value;

    const latitude = firstValue(row, ['lat', 'latitude']);
    const longitude = firstValue(row, ['lon', 'lng', 'longitude']);
    const speciesId = firstValue(row, ['pokemon_id', 'pokemonid', 'species_id', 'speciesid', 'pokemon']);
    const name = firstValue(row, ['pokemon_name', 'species_name', 'name', 'display_name']);
    const expiry = firstValue(row, ['expire_timestamp', 'expiration_timestamp_ms', 'expiration_time', 'despawn_time', 'expires_at', 'expiry']);

    const explicitEncounterId = firstValue(row, ['encounter_id', 'encounterid']);
    // Plain `id` is only treated as an encounter ID when the selected source
    // has a documented contract for it (e.g. Golbat). For other feeds it may
    // only be a provider's own record/spawn key.
    const encounterId = explicitEncounterId ?? (row.__encounter_id_verified ? firstValue(row, ['id']) : undefined);
    return {
      name: name ? String(name) : `Pokémon ${speciesId ?? 'unknown'}`,
      pokemonId: speciesId,
      encounterId,
      encounterIdVerified: encounterId !== undefined && encounterId !== null && String(encounterId).trim() !== '',
      spawnId: firstValue(row, ['spawn_id', 'spawnpoint_id', 'spawn_point_id', 'spawnpointid', 'id']),
      latitude: latitude,
      longitude: longitude,
      expiresAt: expiry,
      cp: firstValue(row, ['cp', 'combat_power']),
      iv: firstValue(row, ['iv', 'iv_percent', 'individual_value']),
      sourceShiny: firstValue(row, ['shiny']),
      predictedShiny: firstValue(row, ['predicted_shiny', 'is_shiny_for_trainer', 'shiny_for_account', 'account_shiny']),
      computedShiny: undefined,
      predictionState: '',
      raw: row
    };
  }

  function extractRows(payload) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== 'object') throw new Error('The source did not return a JSON object or array.');
    for (const key of ['pokemon', 'spawns', 'results', 'records', 'data', 'items']) {
      if (Array.isArray(payload[key])) return payload[key];
    }
    throw new Error('Could not find a spawn array. Expected an array or a JSON property named pokemon, spawns, results, records, data, or items.');
  }

  function parseCsv(text) {
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (!lines.length) return [];
    const splitLine = (line) => {
      const values = [];
      let value = '';
      let quoted = false;
      for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (character === '"' && quoted && line[index + 1] === '"') {
          value += '"';
          index += 1;
        } else if (character === '"') {
          quoted = !quoted;
        } else if (character === ',' && !quoted) {
          values.push(value.trim());
          value = '';
        } else {
          value += character;
        }
      }
      values.push(value.trim());
      return values;
    };
    const headers = splitLine(lines[0]);
    return lines.slice(1).map((line) => {
      const values = splitLine(line);
      return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
    });
  }

  function parseExpiry(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'string' && /\D/.test(value) && Number.isNaN(Number(value))) {
      const parsedDate = Date.parse(value);
      return Number.isFinite(parsedDate) ? parsedDate : null;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    // Golbat and most mappers use Unix seconds; older exports may use milliseconds.
    return numeric < 100000000000 ? numeric * 1000 : numeric;
  }

  function formatExpiry(value) {
    const milliseconds = parseExpiry(value);
    if (!milliseconds) return 'Expiry unknown';
    const date = new Date(milliseconds);
    if (Number.isNaN(date.getTime())) return 'Expiry unknown';
    const remainingSeconds = Math.floor((date.getTime() - Date.now()) / 1000);
    if (remainingSeconds <= 0) return `Expired at ${date.toLocaleTimeString()}`;
    const minutes = Math.floor(remainingSeconds / 60);
    const seconds = remainingSeconds % 60;
    const remaining = minutes >= 60
      ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
      : `${minutes}m ${seconds}s`;
    return `Expires ${date.toLocaleTimeString()} · ${remaining} left`;
  }

  function haversineKm(lat1, lon1, lat2, lon2) {
    const toRad = (degrees) => degrees * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  }

  function validateSearchArea() {
    const latitude = Number(latitudeInput.value);
    const longitude = Number(longitudeInput.value);
    const radius = Number(radiusInput.value);
    const speciesRaw = speciesInput.value.trim();
    const speciesId = speciesRaw ? Number(speciesRaw) : null;

    if (!latitudeInput.value.trim() || !longitudeInput.value.trim() || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      throw new Error('Enter a valid center latitude from -90 to 90.');
    }
    if (!longitudeInput.value.trim() || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw new Error('Enter a valid center longitude from -180 to 180.');
    }
    if (!Number.isFinite(radius) || radius < 0.1 || radius > 25) {
      throw new Error('Radius must be between 0.1 and 25 km.');
    }
    if (speciesId !== null && (!Number.isInteger(speciesId) || speciesId < 1 || speciesId > 2000)) {
      throw new Error('Pokémon ID must be a positive whole number.');
    }
    return { latitude, longitude, radius, speciesId };
  }

  async function fetchIFlowGo(area) {
    const response = await fetch('/api/iflowgo-nearby', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        latitude: area.latitude,
        longitude: area.longitude,
        radiusKm: area.radius,
        speciesId: area.speciesId,
        limit: 800
      })
    });
    const payload = await readResponse(response);
    return { rows: extractRows(payload), label: 'iFlowGo nearby' };
  }

  async function fetchGolbat(area) {
    const response = await fetch('/api/golbat-scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        latitude: area.latitude,
        longitude: area.longitude,
        radiusKm: area.radius,
        speciesId: area.speciesId,
        limit: 1000
      })
    });
    const payload = await readResponse(response);
    return { rows: extractRows(payload), label: 'Golbat mapper' };
  }

  async function fetchJsonFeed(area) {
    const url = feedUrlInput.value.trim();
    if (!url) throw new Error('Enter the JSON feed URL.');
    let parsedUrl;
    try { parsedUrl = new URL(url); } catch { throw new Error('The JSON feed URL is invalid.'); }
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') throw new Error('Feed URL must use HTTP or HTTPS.');

    const headers = { 'Accept': 'application/json' };
    const token = feedTokenInput.value.trim();
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(parsedUrl.href, { method: 'GET', headers, cache: 'no-store' });
    const payload = await readResponse(response);
    return { rows: extractRows(payload), label: new URL(feedUrlInput.value).hostname };
  }

  async function readResponse(response) {
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : {}; } catch {
      throw new Error(`The server returned non-JSON content (HTTP ${response.status}). Check the endpoint URL.`);
    }
    if (!response.ok) {
      const detail = payload.message || payload.error || payload.detail || `HTTP ${response.status}`;
      throw new Error(String(detail));
    }
    return payload;
  }

  function rowsFromLocalFile() {
    if (!loadedFileRows) throw new Error('Choose a JSON or CSV file first.');
    return { rows: loadedFileRows, label: fileInput.files?.[0]?.name || 'local file' };
  }

  function normalizeRows(rows, area, source) {
    const sourceRows = source === 'iflowgo'
      ? rows.map((row) => {
          // Community integration code uses iFlowGo's `id` as its spawn identifier;
          // do not mislabel it as the game's encounter ID.
          if (!row || typeof row !== 'object') return row;
          const hasEncounterId = row.encounter_id !== undefined || row.encounterId !== undefined;
          return {
            ...row,
            spawn_id: row.spawn_id ?? row.spawnId ?? row.id,
            encounter_id: row.encounter_id ?? row.encounterId,
            __encounter_id_verified: Boolean(hasEncounterId),
            // iFlowGo's public client treats `id` as its source spawn key, not an encounter ID.
            id: undefined,
            name: row.pokemon_name ?? row.name ?? row.species_name
          };
        })
      : source === 'golbat'
        ? rows.map((row) => row && typeof row === 'object' ? { ...row, __encounter_id_verified: true } : row)
        : rows;
    const normalized = sourceRows
      .filter((row) => row && typeof row === 'object' && !Array.isArray(row))
      .map(normalizeRecord)
      .filter((row) => {
        if (area.speciesId !== null && Number(row.pokemonId) !== area.speciesId) return false;
        const lat = Number(row.latitude);
        const lon = Number(row.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return false;
        return haversineKm(area.latitude, area.longitude, lat, lon) <= area.radius;
      });
    // Deduplicate by encounter ID if a provider repeats rows; otherwise fall back to coordinates and species.
    const seen = new Set();
    return normalized.filter((row) => {
      const key = row.encounterId !== undefined
        ? `enc:${String(row.encounterId)}`
        : `pos:${row.pokemonId}:${Number(row.latitude).toFixed(5)}:${Number(row.longitude).toFixed(5)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => (parseExpiry(a.expiresAt) ?? Infinity) - (parseExpiry(b.expiresAt) ?? Infinity));
  }

  function formatCoordinate(value, digits = 6) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric.toFixed(digits) : '—';
  }

  function getPredictionLabel(record) {
    if (record.predictionState === 'computed') {
      return record.computedShiny
        ? `RNG roll: shiny if eligible · 1/${record.shinyOdds} (draw ${record.shinyDraw.toFixed(6)})`
        : `RNG roll: not shiny · 1/${record.shinyOdds} (draw ${record.shinyDraw.toFixed(6)})`;
    }
    if (record.predictedShiny !== undefined) {
      if (record.predictedShiny === true || record.predictedShiny === 1 || String(record.predictedShiny).toLowerCase() === 'true') return 'Feed says shiny for account';
      if (record.predictedShiny === false || record.predictedShiny === 0 || String(record.predictedShiny).toLowerCase() === 'false') return 'Feed says not shiny';
    }
    if (record.predictionState === 'no-encounter-id') return 'No verified encounter ID';
    if (record.predictionState === 'bad-encounter-id') return 'Invalid encounter ID';
    if (record.predictionState === 'needs-player-id') return 'Internal Player ID required';
    return 'Prediction unavailable';
  }

  async function applyFormulaPredictions(records) {
    const rawPlayerId = playerIdInput.value.trim();
    const playerId = rawPlayerId ? ShinyRoll.normalizePlayerId(rawPlayerId) : null;
    const odds = Number(shinyOddsInput.value);
    if (rawPlayerId && !playerId) {
      throw new Error('Internal Player ID format is invalid. A Friend Code is not accepted by the formula.');
    }
    if (!Number.isInteger(odds) || odds < 1 || odds > 10000) {
      throw new Error('Shiny odds denominator must be a whole number from 1 to 10000.');
    }

    return Promise.all(records.map(async (record) => {
      if (!playerId) {
        return { ...record, predictionState: record.encounterIdVerified ? 'needs-player-id' : 'no-encounter-id' };
      }
      if (!record.encounterIdVerified) return { ...record, predictionState: 'no-encounter-id' };
      const parsedEncounterId = ShinyRoll.parseEncounterId(record.encounterId);
      if (parsedEncounterId === null) return { ...record, predictionState: 'bad-encounter-id' };
      const result = await ShinyRoll.predict(parsedEncounterId, playerId, odds);
      return {
        ...record,
        computedShiny: result.isShiny,
        shinyOdds: odds,
        shinyDraw: result.draw,
        shinyRoll24: result.roll24,
        predictionState: 'computed'
      };
    }));
  }

  function renderRecord(record) {
    const latitude = Number(record.latitude);
    const longitude = Number(record.longitude);
    const coordinates = `${formatCoordinate(latitude)}, ${formatCoordinate(longitude)}`;
    const mapHref = `https://www.google.com/maps?q=${encodeURIComponent(`${latitude},${longitude}`)}`;
    const encounter = record.encounterId ?? '—';
    const spawn = record.spawnId ?? '—';
    const cp = record.cp !== undefined && record.cp !== '' ? ` · CP ${escapeHtml(record.cp)}` : '';
    const iv = record.iv !== undefined && record.iv !== '' ? ` · IV ${escapeHtml(record.iv)}%` : '';
    const sourceFlag = record.sourceShiny !== undefined
      ? `<div class="record-meta">Source shiny field: ${escapeHtml(record.sourceShiny)}</div>`
      : '';
    const predictionClass = record.predictionState === 'computed'
      ? (record.computedShiny ? ' predicted-shiny' : ' predicted-not-shiny')
      : ' needs-data';
    return `<article class="record">
      <div>
        <h3 class="record-title">${escapeHtml(record.name)}</h3>
        <div class="record-meta">Pokémon ID: ${escapeHtml(record.pokemonId ?? '—')}${cp}${iv}</div>
        <div class="record-meta">Encounter ID: ${escapeHtml(encounter)}${record.encounterIdVerified ? ' · verified source field' : ' · unverified/missing'}</div>
        <div class="record-meta">Spawn/source ID: ${escapeHtml(spawn)}</div>
        <div class="record-meta">${escapeHtml(coordinates)} · ${escapeHtml(formatExpiry(record.expiresAt))}</div>
        ${record.predictionState === 'computed' ? `<div class="record-meta">24-bit roll: ${record.shinyRoll24} / 16777215 · cutoff: ${Math.ceil(16777216 / record.shinyOdds) - 1}</div>` : ''}
        ${sourceFlag}
        <div class="record-links"><a href="${mapHref}" target="_blank" rel="noopener noreferrer">Open map ↗</a><a href="#" class="copy-coords" data-coords="${escapeHtml(`${latitude}, ${longitude}`)}">Copy coordinates</a></div>
      </div>
      <span class="record-status${predictionClass}">${escapeHtml(getPredictionLabel(record))}</span>
    </article>`;
  }

  function renderResults(records, sourceLabel, area) {
    lastRecords = records;
    shownCount = 0;
    resultsSection.hidden = false;
    resultsTitle.textContent = 'Spawn records';
    resultCount.textContent = `${records.length} record${records.length === 1 ? '' : 's'}`;
    resultSource.textContent = sourceLabel;
    recordsList.innerHTML = '';

    if (!records.length) {
      recordsList.innerHTML = '<div class="empty-state"><strong>No matching spawn records</strong>The source returned no records within this radius. Try a larger area, remove the Pokémon ID filter, or check whether the mapper has recent data for this location.</div>';
      paginationRow.hidden = true;
    } else {
      renderMoreRecords();
    }
    const predictedCount = records.filter((record) => record.predictionState === 'computed').length;
    resultsNote.textContent = `Radius: ${area.radius} km around ${area.latitude.toFixed(5)}, ${area.longitude.toFixed(5)}. Records are sorted by expiry. Formula predictions computed: ${predictedCount}/${records.length}. Only verified encounter IDs are rolled; missing IDs are not guessed. Species/form shiny-release eligibility is not yet checked, so a positive is conditional on the form being shiny-eligible.`;
    resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderMoreRecords() {
    const nextRecords = lastRecords.slice(shownCount, shownCount + PAGE_SIZE);
    recordsList.insertAdjacentHTML('beforeend', nextRecords.map(renderRecord).join(''));
    shownCount += nextRecords.length;
    paginationRow.hidden = shownCount >= lastRecords.length;
    paginationLabel.textContent = `Showing ${shownCount} of ${lastRecords.length}`;
  }

  async function search(event) {
    event?.preventDefault();
    try {
      const area = validateSearchArea();
      const rawPlayerId = playerIdInput.value.trim();
      if (rawPlayerId && !ShinyRoll.normalizePlayerId(rawPlayerId)) throw new Error('Internal Player ID format is invalid. A 12-digit Friend Code is not accepted by the formula.');
      const odds = Number(shinyOddsInput.value);
      if (!Number.isInteger(odds) || odds < 1 || odds > 10000) throw new Error('Shiny odds denominator must be a whole number from 1 to 10000.');

      setStatus('Querying the selected data source…');
      searchButton.disabled = true;
      buttonLabel.textContent = 'Searching…';

      let result;
      if (sourceMode === 'iflowgo') result = await fetchIFlowGo(area);
      else if (sourceMode === 'golbat') result = await fetchGolbat(area);
      else if (sourceMode === 'feed') result = await fetchJsonFeed(area);
      else result = rowsFromLocalFile();

      const records = normalizeRows(result.rows, area, sourceMode);
      const predictedRecords = await applyFormulaPredictions(records);
      renderResults(predictedRecords, result.label, area);
      const predictedCount = predictedRecords.filter((record) => record.predictionState === 'computed').length;
      if (playerIdInput.value.trim()) {
        setStatus(`Received ${result.rows.length} source row(s); ${records.length} matched. Formula predictions computed for ${predictedCount} row(s). Player ID stayed in your browser.`, 'success');
      } else {
        setStatus(`Received ${result.rows.length} source row(s); ${records.length} matched. Enter the internal game Player ID to calculate account-specific results.`, 'success');
      }
    } catch (error) {
      setStatus(error.message || 'Search failed.', 'error');
      resultsSection.hidden = false;
      resultsTitle.textContent = 'Unable to search';
      resultCount.textContent = '';
      resultSource.textContent = sourceMode === 'iflowgo' ? 'iFlowGo' : sourceMode === 'golbat' ? 'Golbat' : sourceMode === 'feed' ? 'JSON feed' : 'Local file';
      resultsNote.textContent = 'Prediction was not completed. Review the error and connection settings.';
      recordsList.innerHTML = `<div class="empty-state"><strong>Search did not complete</strong>${escapeHtml(error.message || 'Unknown error.')}</div>`;
      paginationRow.hidden = true;
    } finally {
      searchButton.disabled = false;
      buttonLabel.textContent = 'Search spawn data';
    }
  }

  function setSource(mode) {
    sourceMode = mode;
    $$('.source-tab').forEach((button) => {
      const active = button.dataset.source === mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    $$('.source-pane').forEach((pane) => pane.classList.add('hidden'));
    $(`#pane-${mode}`).classList.remove('hidden');
  }

  trainerCodeInput.addEventListener('input', () => {
    const digits = trainerCodeInput.value.replace(/\\D/g, '').slice(0, 12);
    trainerCodeInput.value = digits.replace(/(\\d{4})(?=\\d)/g, '$1 ').trim();
  });

  linkTrainerButton.addEventListener('click', async () => {
    const trainerCode = trainerCodeInput.value.replace(/\\D/g, '');
    if (!/^\\d{12}$/.test(trainerCode)) {
      setStatus('Enter the 12-digit Trainer Code first.', 'error');
      return;
    }
    linkTrainerButton.disabled = true;
    linkTrainerButton.textContent = 'Resolving…';
    setStatus('Sending the code only to your configured Player ID linker…');
    try {
      const response = await fetch('/api/link-trainer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trainerCode })
      });
      const payload = await readResponse(response);
      const playerId = globalThis.ShinyRoll.normalizePlayerId(payload.playerId ?? payload.player_id);
      if (!playerId) throw new Error('The linker response did not contain a valid internal Player ID. Expected playerId or player_id.');
      playerIdInput.value = playerId;
      const name = payload.trainerName ?? payload.trainer_name;
      setStatus(`Linked${name ? ` trainer ${name}` : ' trainer'} successfully. Predictions will use this ID locally.`, 'success');
    } catch (error) {
      setStatus(error.message || 'Could not resolve the Trainer Code.', 'error');
    } finally {
      linkTrainerButton.disabled = false;
      linkTrainerButton.textContent = 'Resolve ID';
    }
  });

  playerIdInput.addEventListener('input', () => {
    playerIdInput.value = playerIdInput.value.trim().toLowerCase();
  });

  $$('.source-tab').forEach((button) => button.addEventListener('click', () => setSource(button.dataset.source)));
  form.addEventListener('submit', search);
  showMoreButton.addEventListener('click', renderMoreRecords);

  fileInput.addEventListener('change', async () => {
    loadedFileRows = null;
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const content = await file.text();
      const parsed = /\.csv$/i.test(file.name) ? parseCsv(content) : JSON.parse(content);
      loadedFileRows = extractRows(parsed);
      setStatus(`Loaded ${loadedFileRows.length} raw rows from ${file.name}.`, 'success');
    } catch (error) {
      loadedFileRows = null;
      setStatus(`Could not load file: ${error.message || 'invalid format'}`, 'error');
    }
  });

  recordsList.addEventListener('click', async (event) => {
    const link = event.target.closest('.copy-coords');
    if (!link) return;
    event.preventDefault();
    const coordinates = link.dataset.coords || '';
    try {
      await navigator.clipboard.writeText(coordinates);
      setStatus('Coordinates copied.', 'success');
    } catch {
      setStatus(`Copy is unavailable in this browser. Coordinates: ${coordinates}`);
    }
  });

  clearButton.addEventListener('click', () => {
    form.reset();
    loadedFileRows = null;
    lastRecords = [];
    shownCount = 0;
    fileInput.value = '';
    resultsSection.hidden = true;
    recordsList.innerHTML = '';
    setSource('iflowgo');
    setStatus('Cleared. Choose a data source and search area.');
  });

  setSource('iflowgo');
})();
