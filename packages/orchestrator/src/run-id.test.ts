import { test } from 'vitest';
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

test('extractFeatureId — accepts the full work-item id vocabulary (EI-35)', () => {
  // Not just coding `F-` ids: the unified `WI-NNN` scheme (D-008) + every
  // blueprint idPrefix (research R, migration M, audit AUD, …). The old
  // `^F-…` regex rejected these → research roles got featureId=null.
  assert.equal(extractFeatureId(['FEATURE_ID=WI-12']), 'WI-12', 'unified WI- id');
  assert.equal(extractFeatureId(['FEATURE_ID=R-1']), 'R-1', 'research id');
  assert.equal(extractFeatureId(['FEATURE_ID=AUD-42']), 'AUD-42', 'multi-letter prefix');
  assert.equal(extractFeatureId(['FEATURE_ID=F-GYM-A02F4A66']), 'F-GYM-A02F4A66', 'gym feature id');
});

test('extractFeatureId — rejects junk values', () => {
  assert.equal(extractFeatureId(['FEATURE_ID=invalid']), null, 'no prefix-dash rejected');
  assert.equal(extractFeatureId(['FEATURE_ID=F-001-alpha']), null, 'lowercase tail rejected');
  assert.equal(extractFeatureId(['FEATURE_ID=F-']), null, 'empty tail rejected');
  assert.equal(extractFeatureId(['FEATURE_ID=']), null, 'empty value rejected');
  assert.equal(extractFeatureId(['FEATURE_ID=wi-12']), null, 'lowercase prefix rejected');
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
