import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { TextEncoder, TextDecoder } from 'node:util';

const source = await readFile(new URL('./shiny-roll.js', import.meta.url), 'utf8');
const sandbox = { crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, DataView, BigInt, atob: globalThis.atob };
sandbox.globalThis = sandbox;
runInNewContext(source, sandbox, { filename: 'shiny-roll.js' });
const { predict, normalizePlayerId, parseEncounterId } = sandbox.ShinyRoll;

// Reference nextInt(512) vectors copied from the public implementation's tests,
// themselves checked against java.util.Random / Golbat's test vectors.
const vectors = [
  ['1', '0123456789abcdef', 113],
  ['9007199254740993', '0123456789abcdef', 408], // exceeds Number.MAX_SAFE_INTEGER
  ['18446744073709551615', '0123456789abcdef', 253], // max unsigned uint64
  ['12345678901234567890', '123456789012345678901', 265],
  ['4611686018427387904', '123456789012345678901', 442],
  ['5550001112223334445', 'fedcba9876543210', 27],
  ['10000000000000000168', '0123456789abcdef', 0],
  ['10000000000000000398', '0123456789abcdef', 0],
  ['7000000000000000028', '123456789012345678901', 0]
];
for (const [encounterId, playerId, roll512] of vectors) {
  const result = await predict(encounterId, playerId, 512);
  assert.equal(Math.floor(result.draw * 512), roll512, `wrong reference roll for encounter ${encounterId}`);
  assert.equal(result.isShiny, roll512 === 0, `wrong shiny result for encounter ${encounterId}`);
}

// Exact nextFloat from Golbat's reference vector.
const first = await predict('1', '0123456789abcdef', 512);
assert.equal(first.draw, 0.22137850522994995);

// Older tools sometimes base64-encode the decimal encounter ID.
assert.equal(parseEncounterId('MTY4MjU4OTY4Njg2MjExOTUwNA=='), '1682589686862119504');
assert.equal(normalizePlayerId('0123456789ABCDEF'), '0123456789abcdef');
assert.equal(normalizePlayerId('035287579185'), null); // Friend Code is not the RNG identity.
assert.equal(parseEncounterId('18446744073709551616'), null); // outside uint64 range
console.log(`PASS: ${vectors.length} Java Random reference rolls, exact nextFloat, base64 ID and identifier validation.`);
