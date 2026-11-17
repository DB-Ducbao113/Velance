import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseJourneyArgs, runUserJourneys, validateAssetInventory, validateHttpObject } from '../p4_user_journeys.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'velance-p4-journey-test-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const sourceRoot = join(root, 'public'), report = join(root, 'profile.json');
  const put = (file, body) => {
    const path = join(sourceRoot, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    return path;
  };
  put('index.html', '<!doctype html><html><body>fixture release</body></html>');
  for (let i = 1; i <= 16; i++) {
    const car = `car-${String(i).padStart(2, '0')}`;
    const fakeGLB = Buffer.alloc(2048 + i, i);
    fakeGLB.write('glTF', 0);
    put(`assets/models/${car}.glb`, fakeGLB);
    for (let frame = 1; frame <= 5; frame++) {
      const webp = Buffer.alloc(180 + frame, i ^ frame);
      webp.write('RIFF', 0); webp.write('WEBP', 8);
      put(`assets/images/${car}/${frame}.webp`, webp);
    }
  }
  return { root, sourceRoot, report, put };
}

test('CLI controls do not accidentally start a heavy 100-user simulation and enforce strict caps', () => {
  assert.deepEqual(parseJourneyArgs(['--help']), { help: true });
  assert.equal(parseJourneyArgs(['--users', '1', '--out', '/tmp/fixture.json']).users[0], 1);
  assert.deepEqual(parseJourneyArgs(['--users', '10,25,50,100', '--images', '5',
    '--concurrency', '32', '--max-seconds', '240', '--out', '/tmp/fixture.json']).users, [10, 25, 50, 100]);
  for (const args of [
    [], ['--out', '/tmp/x.json'], ['--users', '100'], ['--users', '101', '--out', '/tmp/x.json'],
    ['--users', '2', '--out', '/tmp/x.json'], ['--users', '10,10', '--out', '/tmp/x.json'],
    ['--users', '10,25,50,100,1', '--out', '/tmp/x.json'],
    ['--users', '10', '--images', '6', '--out', '/tmp/x.json'],
    ['--users', '10', '--concurrency', '33', '--out', '/tmp/x.json'],
    ['--users', '10', '--concurrency', '0', '--out', '/tmp/x.json'],
    ['--users', '10', '--max-seconds', '241', '--out', '/tmp/x.json'],
    ['--users', '10', '--max-seconds', '4', '--out', '/tmp/x.json'],
    ['--users', '10', '--out', '/tmp/x.json', '--out', '/tmp/y.json'],
    ['--users', '10', '--out', '/tmp/x.json', '--unrecognized', '1']
  ]) assert.throws(() => parseJourneyArgs(args), Error, args.join(' '));
});

test('inventory is strict: no guessing if one GLB, one WebP or a full album is missing', t => {
  const { sourceRoot, put } = fixture(t);
  const inv = validateAssetInventory({ sourceRoot });
  assert.equal(inv.modelCount, 16);
  assert.equal(inv.imageCount, 80);
  assert.equal(inv.albums.length, 16);
  assert(inv.albums.every(album => album.length === 5));
  assert.equal(inv.modelPaths.length, 16);
  assert(inv.allModelBytes > 32_000);
  rmSync(join(sourceRoot, 'assets/models/car-16.glb'));
  assert.throws(() => validateAssetInventory({ sourceRoot }), /Model inventory mismatch/);
  put('assets/models/car-16.glb', Buffer.alloc(2048, 0x7f));
  rmSync(join(sourceRoot, 'assets/images/car-01/1.webp'));
  assert.throws(() => validateAssetInventory({ sourceRoot }), /Expected exactly 5 regular WebP/);
});

test('SHA256 + full response, HTTP 200 and conditional 304 are mandatory, incomplete 200 is a failure', () => {
  const payload = Buffer.from('contents');
  const sha = createHash('sha256').update(payload).digest('hex');
  const spec = { path: '/assets/models/example.glb', bytes: payload.length, sha256: sha };
  const response = {
    status: 200, complete: true, error: null, bytes: payload.length, sha256: sha,
    headers: { etag: `"${sha}-identity"`, 'cache-control': 'public, max-age=31536000, immutable',
      vary: 'Accept-Encoding', 'content-length': String(payload.length), 'content-type': 'model/gltf-binary',
      'content-encoding': null }
  };
  assert.deepEqual(validateHttpObject(response, spec), []);
  assert(validateHttpObject({ ...response, complete: false }, spec).includes('INCOMPLETE_RESPONSE'));
  assert(validateHttpObject({ ...response, status: 503 }, spec).includes('EXPECTED_200_GOT_503'));
  assert(validateHttpObject({ ...response, bytes: 0 }, spec).includes('SIZE_MISMATCH'));
  assert(validateHttpObject({ ...response, sha256: 'bad' }, spec).includes('SHA256_MISMATCH'));
  assert(validateHttpObject({ ...response, headers: { ...response.headers, etag: 'wrong' } }, spec).includes('ETAG_MISMATCH'));
  const revalidated = { ...response, status: 304, bytes: 0,
    sha256: createHash('sha256').update('').digest('hex'),
    headers: { ...response.headers, 'content-length': null } };
  assert.deepEqual(validateHttpObject(revalidated, spec, true), []);
  assert(validateHttpObject({ ...revalidated, bytes: 1 }, spec, true).includes('304_HAS_BODY'));
});

test('tiny 1/10 fixture virtual clients stream all sixteen GLBs, selected WebPs, warm 304 and current release', async t => {
  const { sourceRoot, report } = fixture(t);
  const baseline = readFileSync(join(sourceRoot, 'assets/models/car-01.glb'));
  const result = await runUserJourneys({ users: [1, 10], images: 5, concurrency: 4,
    maxSeconds: 20, sourceRoot, out: report });
  assert.equal(result.format, 'velance-p4-real-asset-virtual-journeys/1');
  assert.deepEqual(result.config.virtualHttpUsers, [1, 10]);
  assert.equal(result.assets.models, 16);
  assert.equal(result.assets.carWebpImages, 80);
  assert.equal(result.assets.totalSnapshotFiles, 97, 'fixture includes 16 GLB, 80 WebP and index.html');
  assert.equal(result.assets.totalModelBytesPerUser, validateAssetInventory({ sourceRoot }).allModelBytes);
  assert.equal(result.profiles.length, 2);
  assert.equal(result.passed, true, JSON.stringify(result.profiles.map(p => p.requests.failuresByCode)));
  for (const profile of result.profiles) {
    const n = profile.virtualHttpClients;
    assert.equal(profile.passed, true);
    assert.equal(profile.expected.full200, n * 21);
    assert.equal(profile.expected.warm304, n);
    assert.equal(profile.requests.offered, n * 22);
    assert.equal(profile.requests.sent, n * 22);
    assert.equal(profile.requests.completed, n * 22);
    assert.equal(profile.requests.completed200, n * 21);
    assert.equal(profile.requests.completed304, n);
    assert.equal(profile.requests.incomplete200, 0);
    assert.equal(profile.requests.failedVerification, 0);
    assert.equal(profile.requests.status429, 0);
    assert.equal(profile.requests.status503, 0);
    assert.equal(profile.requests.warmBodyBytes, 0);
    assert.equal(profile.requests.receivedBodyBytes, profile.requests.verifiedBodyBytes);
    assert(profile.observedPeakInFlight <= 4);
    assert.equal(profile.journeys.length, n);
    assert.equal(Object.keys(profile.latencyMs.perObjectPath).length, 16 + Math.min(n, 16) * 5,
      'all 16 GLBs plus the five images from each selected album');
    assert(profile.latencyMs.perObject.p95 !== null);
    assert(profile.latencyMs.fullJourney.p95 !== null);
    assert(profile.latencyMs.firstAssetReady.p95 !== null);
    assert(profile.latencyMs.all16Ready.p95 !== null);
    assert(profile.activeRoute.before.passed);
    assert(profile.activeRoute.after.passed);
    assert.equal(profile.activeRoute.pointerState.active, result.assets.releasedId);
    assert(profile.resourceUsage.processRssSampledPeakBytes > 0);
    assert(profile.resourceUsage.diskBefore.snapshotApparentBytes > 0);
    assert(profile.throughput.actualReceivedMiBps > 0);
    for (const journey of profile.journeys) {
      assert.equal(journey.passed, true);
      assert.equal(journey.validModels, 16);
      assert.equal(journey.validImages, 5);
      assert.equal(journey.models.length, 16);
      assert.equal(journey.pictures.length, 5);
      assert(journey.warm.verified);
      assert.equal(journey.warm.status, 304);
      assert.equal(journey.warm.bytes, 0);
      assert(journey.all16ReadyMs >= journey.firstAssetReadyMs);
      assert(journey.totalJourneyMs >= journey.all16ReadyMs);
      assert(journey.models.every(object => object.status === 200 && object.complete && object.verified));
      assert(journey.pictures.every(object => object.status === 200 && object.complete && object.verified));
    }
  }
  assert.deepEqual(readFileSync(join(sourceRoot, 'assets/models/car-01.glb')), baseline, 'source bytes are not modified');
  assert.deepEqual(JSON.parse(readFileSync(report, 'utf8')), result, 'raw report output must be complete JSON');
  await assert.rejects(runUserJourneys({ users: [1], images: 0, concurrency: 2,
    maxSeconds: 10, sourceRoot, out: report }), { code: 'REPORT_EXISTS' });
});
