import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSpeakers } from '../src/transcript.js';

const segs = [{ speaker: 'Priya', start: 0, end: 60, text: 'hi' }, { speaker: 'Marcus', start: 60, end: 100, text: 'yo' }];

test('lists everyone who joined, including people who never spoke', () => {
  const out = buildSpeakers([{ name: 'Priya', isHost: true }, { name: 'Marcus' }, { name: 'Elena' }], segs);
  assert.deepEqual(out.map((s) => s.name), ['Priya', 'Marcus', 'Elena']);
  assert.equal(out.find((s) => s.name === 'Elena').pct, 0);
  assert.equal(out[0].host, true);
});
test('falls back to the people who spoke when there are no participant events', () => {
  assert.deepEqual(buildSpeakers([], segs).map((s) => s.name), ['Priya', 'Marcus']);
});
test('keeps a speaker whose join event was missed and ignores duplicate names', () => {
  const out = buildSpeakers([{ name: 'Priya' }, { name: 'priya' }, { name: '' }], segs);
  assert.deepEqual(out.map((s) => s.name), ['Priya', 'Marcus']);
});
