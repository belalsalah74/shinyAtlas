/*
 * Account-specific Pokémon GO shiny-roll implementation.
 * Formula reference: https://github.com/rubendgpedrosa/Poliswag/blob/main/modules/shiny_roll.py
 * The browser never sends the Player ID to a server; all calculation is local.
 */
(() => {
  'use strict';

  const MASK_48 = (1n << 48n) - 1n;
  const MULTIPLIER = 0x5DEECE66Dn;
  const ADDEND = 0xBn;
  const UINT64_MAX = (1n << 64n) - 1n;
  const FLOAT_SCALE = 1 << 24;

  function normalizePlayerId(raw) {
    const value = String(raw ?? '').trim().toLowerCase();
    // Shapes observed in public reverse-engineering work: 16–32 lowercase hex
    // characters (including the 24-char object-ID form) or 15–24 decimal digits.
    return /^(?:[0-9a-f]{16,32}|[0-9]{15,24})$/.test(value) ? value : null;
  }

  function parseEncounterId(raw) {
    const value = String(raw ?? '').trim();
    if (/^\d+$/.test(value)) {
      try {
        const n = BigInt(value);
        return n >= 0n && n <= UINT64_MAX ? n.toString() : null;
      } catch { return null; }
    }

    // Some older map exports base64-encode the decimal encounter ID.
    try {
      let encoded = value.replace(/-/g, '+').replace(/_/g, '/');
      encoded += '='.repeat((4 - encoded.length % 4) % 4);
      const binary = atob(encoded);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const decoded = new TextDecoder().decode(bytes).trim();
      if (!/^\d+$/.test(decoded)) return null;
      const n = BigInt(decoded);
      return n >= 0n && n <= UINT64_MAX ? n.toString() : null;
    } catch { return null; }
  }

  function encounterBytesLittleEndian(encounterId) {
    let value = BigInt(encounterId);
    if (value < 0n || value > UINT64_MAX) throw new RangeError('Encounter ID must be an unsigned 64-bit integer.');
    const bytes = new Uint8Array(8);
    for (let i = 0; i < 8; i += 1) {
      bytes[i] = Number(value & 0xffn);
      value >>= 8n;
    }
    return bytes;
  }

  async function predict(encounterIdRaw, playerIdRaw, oddsRaw = 512) {
    const encounterId = parseEncounterId(encounterIdRaw);
    if (encounterId === null) throw new TypeError('A numeric game encounter ID is required.');
    const playerId = normalizePlayerId(playerIdRaw);
    if (!playerId) throw new TypeError('Enter a valid internal game Player ID, not a 12-digit Friend Code.');
    const odds = Number(oddsRaw);
    if (!Number.isFinite(odds) || odds < 1 || odds > 10000) {
      throw new RangeError('Shiny odds denominator must be between 1 and 10000.');
    }
    if (!globalThis.crypto?.subtle) throw new Error('Web Crypto is unavailable. Open this app through its local HTTP server.');

    const encounterBytes = encounterBytesLittleEndian(encounterId);
    const playerBytes = new TextEncoder().encode(playerId);
    const input = new Uint8Array(encounterBytes.length + playerBytes.length);
    input.set(encounterBytes, 0);
    input.set(playerBytes, encounterBytes.length);

    const digest = await globalThis.crypto.subtle.digest('SHA-1', input);
    const seedBytes = new DataView(digest).getBigUint64(0, true);
    let state = (seedBytes ^ MULTIPLIER) & MASK_48;
    // First java.util.Random nextFloat(): LCG update, then the top 24 bits.
    state = (state * MULTIPLIER + ADDEND) & MASK_48;
    const roll24 = Number(state >> 24n);
    const draw = roll24 / FLOAT_SCALE;
    const cutoff = Math.ceil(FLOAT_SCALE / odds);

    return {
      encounterId,
      playerId,
      odds,
      roll24,
      draw,
      cutoff,
      isShiny: roll24 < cutoff
    };
  }

  globalThis.ShinyRoll = Object.freeze({ normalizePlayerId, parseEncounterId, predict });
})();
