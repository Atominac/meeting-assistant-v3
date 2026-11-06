import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTitle } from '../src/titles.js';

test('keeps real meeting names and strips app suffixes', () => {
  assert.equal(cleanTitle('Weekly sync'), 'Weekly sync');
  assert.equal(cleanTitle('Weekly sync - Zoom'), 'Weekly sync');
  assert.equal(cleanTitle('Meet - Q4 Pricing Sync'), 'Q4 Pricing Sync');
});
test('drops generic titles and join codes', () => {
  for (const t of ['Zoom Meeting', 'Zoom', 'Google Meet', 'abc-defg-hij', 'Meet - abc-defg-hij', '', undefined]) assert.equal(cleanTitle(t), '');
});
