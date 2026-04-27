import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFeatureId, makeRunId } from './run-id.js';

test('extractFeatureId — returns null when no FEATURE_ID arg', () => {
  assert.equal(extractFeatureId(['MODE=initial']), null);
  assert.equal(extractFeatureId([]), null);
});

test('extractFeatureId — returns ID when present and valid', () => {
  assert.equal(extractFeatureId(['FEATURE_ID=F-001']), 'F-001');
  assert.equal(extractFeatureId(['FEATURE_ID=F-LANE-2-A1']), 'F-LANE-2-A1');
});

test('extractFeatureId — rejects non-feature-id values (matches bash regex)', () => {
  // bash: [[ "$fid" =~ ^F-[A-Z0-9-]+$ ]]
  assert.equal(extractFeatureId(['FEATURE_ID=invalid']), null, 'lowercase rejected');
  assert.equal(extractFeatureId(['FEATURE_ID=F-001-alpha']), null, 'lowercase tail rejected');
  assert.equal(extractFeatureId(['FEATURE_ID=F-']), null, 'empty tail rejected');
  assert.equal(extractFeatureId(['FEATURE_ID=']), null, 'empty value rejected');
});

test('extractFeatureId — picks first valid FEATURE_ID arg', () => {
  assert.equal(
    extractFeatureId(['MODE=initial', 'FEATURE_ID=F-001', 'FEATURE_ID=F-002']),
    'F-001',
  );
});

test('makeRunId — combines timestamp + role with no feature tag', () => {
  assert.equal(makeRunId('worker', null, 1700000000), '1700000000-worker');
});

test('makeRunId — appends feature tag when present', () => {
  assert.equal(makeRunId('validator', 'F-001', 1700000000), '1700000000-validator-F-001');
});
