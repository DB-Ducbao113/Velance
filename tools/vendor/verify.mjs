import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const directory = new URL('../../vendor/three/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('MANIFEST.json', directory)));
assert.equal(manifest.version, '0.187.0');
for (const [file, entry] of Object.entries(manifest.files)) {
  const buffer = readFileSync(new URL(file, directory));
  assert.equal(buffer.length, entry.bytes, `${file}: byte count mismatch`);
  assert.equal(createHash('sha256').update(buffer).digest('hex'), entry.sha256, `${file}: checksum mismatch`);
}
console.log(`three ${manifest.version}: ${Object.keys(manifest.files).length} vendored file checksums PASS`);
