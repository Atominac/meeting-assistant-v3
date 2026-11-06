import { test } from 'node:test';
import assert from 'node:assert/strict';
import { speechIntervals, assignSpeakers } from '../src/transcript.js';
import { parseDeepgram } from '../src/transcribe.js';

const ev = (event, name, relative) => ({ event: `participant_events.${event}`, name, relative });

test('speech intervals come from speech_on / speech_off / leave and close open speakers at the end', () => {
  const iv = speechIntervals([
    ev('speech_on', 'Ana', 2), ev('speech_off', 'Ana', 6),
    ev('speech_on', 'Ben', 10), ev('leave', 'Ben', 14),
    ev('speech_on', 'Ana', 20),
  ], 30);
  assert.deepEqual(iv, { Ana: [[2, 6], [20, 30]], Ben: [[10, 14]] });
});

test('segments go to whoever was speaking most of the time; neighbours of one speaker merge', () => {
  const intervals = { Ana: [[0, 5]], Ben: [[8, 12]] };
  const out = assignSpeakers([
    { start: 0.5, end: 2, text: 'Hello team.' },
    { start: 2.2, end: 4.5, text: 'Let us start.' },
    { start: 8.5, end: 11, text: 'Sounds good.' },
    { start: 30, end: 32, text: 'Nobody marked.' },
  ], intervals);
  assert.deepEqual(out, [
    { speaker: 'Ana', start: 0.5, end: 4.5, text: 'Hello team. Let us start.' },
    { speaker: 'Ben', start: 8.5, end: 11, text: 'Sounds good.' },
    { speaker: 'Speaker', start: 30, end: 32, text: 'Nobody marked.' },
  ]);
});

test('the marker lag is covered by slack', () => {
  const out = assignSpeakers([{ start: 10, end: 12, text: 'Late marker.' }], { Ana: [[10.8, 12.5]] });
  assert.equal(out[0].speaker, 'Ana');
});

test('Deepgram utterances become segments with a diarization label; a bare transcript still works', () => {
  assert.deepEqual(parseDeepgram({ results: { utterances: [
    { start: 0.2, end: 1.5, transcript: ' Hi there ', speaker: 0 }, { start: 2, end: 3, transcript: '', speaker: 1 }, { start: 4, end: 5, transcript: 'Yes.' },
  ] } }), [
    { start: 0.2, end: 1.5, text: 'Hi there', fallback: 'Speaker 1' },
    { start: 4, end: 5, text: 'Yes.', fallback: 'Speaker' },
  ]);
  assert.deepEqual(parseDeepgram({ results: { channels: [{ alternatives: [{ transcript: 'Short clip.', words: [{ start: 0.1, end: 0.4 }, { start: 0.5, end: 0.9 }] }] }] } }),
    [{ start: 0.1, end: 0.9, text: 'Short clip.', fallback: 'Speaker' }]);
  assert.deepEqual(parseDeepgram({}), []);
});

test('unmarked segments keep the transcriber label', () => {
  const out = assignSpeakers([{ start: 1, end: 2, text: 'a', fallback: 'Speaker 2' }, { start: 2.5, end: 3, text: 'b', fallback: 'Speaker 2' }], {});
  assert.deepEqual(out, [{ speaker: 'Speaker 2', start: 1, end: 3, text: 'a b' }]);
});

test('one voice keeps one name: a label that mostly overlaps a marked speaker takes that name', () => {
  const intervals = { Ana: [[0, 10]] };
  const out = assignSpeakers([
    { start: 1, end: 4, text: 'one', fallback: 'Speaker 1' },
    { start: 6, end: 9, text: 'two', fallback: 'Speaker 1' },
    { start: 30, end: 33, text: 'three', fallback: 'Speaker 1' },   // no marker here, same voice
    { start: 40, end: 43, text: 'four', fallback: 'Speaker 2' },    // a different voice: stays unnamed
  ], intervals, { people: ['Ana', 'Ben'] });
  assert.deepEqual(out.map((s) => [s.speaker, s.text]), [['Ana', 'one'], ['Ana', 'two'], ['Ana', 'three'], ['Speaker 2', 'four']]);
});

test('alone in the call: every line is that person, whatever the transcriber called the voices', () => {
  const out = assignSpeakers([
    { start: 1, end: 4, text: 'hello', fallback: 'Speaker 2' },
    { start: 10, end: 14, text: 'again', fallback: 'Speaker 1' },
  ], {}, { people: ['Alok Fitness'] });
  assert.deepEqual(out.map((s) => s.speaker), ['Alok Fitness', 'Alok Fitness']);
  // With several people and no markers nobody is guessed.
  const many = assignSpeakers([{ start: 1, end: 4, text: 'hi', fallback: 'Speaker 2' }], {}, { people: ['A', 'B'] });
  assert.equal(many[0].speaker, 'Speaker 2');
});

test('a single transcriber label says nothing about who is who: unmarked lines stay unnamed', () => {
  // Reported case: two people, only one of them ever marked as speaking, Deepgram heard one voice.
  const out = assignSpeakers([
    { start: 7, end: 9, text: 'a', fallback: 'Speaker 1' },
    { start: 25.5, end: 30, text: 'b', fallback: 'Speaker 1' },
  ], { Fitness: [[25.9, 31.9]] }, { people: ['Yadav', 'Fitness'] });
  assert.deepEqual(out.map((s) => s.speaker), ['Speaker 1', 'Fitness']);
});

test('microphone channel: the local user is identified by channel, the other person is the only one left', () => {
  const out = assignSpeakers([
    { start: 1, end: 3, text: 'hello', channel: 1, fallback: 'Speaker 1' },
    { start: 4, end: 7, text: 'hi there', channel: 0, fallback: 'Speaker 1' },
    { start: 9, end: 11, text: 'thanks', channel: 1, fallback: 'Speaker 1' },
  ], {}, { people: ['Yadav', 'Fitness'], me: 'Fitness' });
  assert.deepEqual(out.map((s) => [s.speaker, s.text]), [['Fitness', 'hello'], ['Yadav', 'hi there'], ['Fitness', 'thanks']]);
  // Without the microphone channel the same segments are not guessed.
  const mono = assignSpeakers([{ start: 4, end: 7, text: 'hi there', fallback: 'Speaker 1' }], {}, { people: ['Yadav', 'Fitness'] });
  assert.equal(mono[0].speaker, 'Speaker 1');
});

test('Deepgram channel numbers are kept on segments', () => {
  const segs = parseDeepgram({ results: { utterances: [{ start: 0, end: 1, transcript: 'x', speaker: 0, channel: 1 }] } });
  assert.equal(segs[0].channel, 1);
});
