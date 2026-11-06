// Detection rules, detector and participant tracking, run on synthetic accessibility trees.
// The trees are modelled on the reference SDK's strings, NOT on recordings of live calls: they prove the logic,
// not the selectors. Replace them with recorded fixtures (docs/PLAN.md, Phase 1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const sdk = createRequire(import.meta.url)('../packages/sdk');
const skip = process.platform !== 'darwin';

const N = (role, props = {}, children = []) => ({ role, ...props, children });
const button = (label) => N('AXButton', { desc: label });
const text = (value) => N('AXStaticText', { value });
const observe = (bundleId, tree) => sdk._debug('debugObserve', { bundleId, tree: JSON.stringify(tree) });

const meetWindow = (url, title, controls) =>
  N('AXWindow', { title }, [N('AXWebArea', { url }, controls)]);
const chrome = (...windows) => N('AXApplication', { title: 'Google Chrome' }, windows);

test.before(async () => {
  if (!skip) await sdk.init({ apiUrl: 'https://api.example.com', disableDetection: true });
});
test.after(async () => { if (!skip) await sdk.shutdown(); });

test('Google Meet in Chrome: live call, lobby, after-call screen', { skip }, async () => {
  const live = await observe('com.google.Chrome', chrome(
    meetWindow('https://meet.google.com/abc-defg-hij?authuser=0', 'Weekly sync - Google Chrome', [button('Leave call'), button('Mute')])));
  assert.equal(live.length, 1);
  assert.deepEqual(
    { platform: live[0].platform, key: live[0].key, live: live[0].live, title: live[0].title, url: live[0].url },
    { platform: 'google-meet', key: 'google-meet:abc-defg-hij', live: true, title: 'Weekly sync', url: 'https://meet.google.com/abc-defg-hij' });

  const lobby = await observe('com.google.Chrome', chrome(
    meetWindow('https://meet.google.com/abc-defg-hij', 'Meet - Google Chrome', [button('Join now')])));
  assert.equal(lobby[0].live, false);
  assert.equal(lobby[0].afterCall, false);

  const after = await observe('com.google.Chrome', chrome(
    meetWindow('https://meet.google.com/abc-defg-hij', 'Meet - Google Chrome', [text('You left the meeting'), button('Rejoin')])));
  assert.equal(after[0].live, false);
  assert.equal(after[0].afterCall, true);
});

test('Meet with the /meet/<code> address and Chrome profile suffix (shape taken from a real Chrome dump)', { skip }, async () => {
  const tree = chrome(N('AXWindow', { title: 'Meet – byz-zpua-dkk – Microphone recording - Google Chrome – Alok' }, [
    N('AXGroup', { domClass: 'BrowserRootView' }, [N('AXTextField', { value: 'meet.google.com/meet/byz-zpua-dkk?authuser=0' })]),
    N('AXWebArea', { title: 'Meet – byz-zpua-dkk', url: 'https://meet.google.com/meet/byz-zpua-dkk?authuser=0' }, [
      N('AXGroup', {}, [N('AXButton', { title: 'Leave call', desc: 'Leave call' })])]),
  ]));
  const r = await observe('com.google.Chrome', tree);
  assert.equal(r.length, 1);
  assert.deepEqual({ key: r[0].key, live: r[0].live, url: r[0].url, title: r[0].title },
    { key: 'google-meet:byz-zpua-dkk', live: true, url: 'https://meet.google.com/byz-zpua-dkk', title: 'Meet – byz-zpua-dkk' });
});

test('Meet is recognised in other Chromium browsers and ignores unrelated pages', { skip }, async () => {
  const edge = await observe('com.microsoft.edgemac', N('AXApplication', {}, [
    meetWindow('https://meet.google.com/aaa-bbbb-ccc', 'x - Microsoft Edge', [button('Leave call')])]));
  assert.equal(edge[0].platform, 'google-meet');
  assert.deepEqual(await observe('com.google.Chrome', chrome(meetWindow('https://example.com/', 'Example', [button('Leave call')]))), []);
  assert.deepEqual(await observe('com.google.Chrome', chrome(meetWindow('https://meet.google.com/landing', 'Meet', []))), []);
  assert.deepEqual(await observe('com.example.NotWatched', chrome()), []);
});

test('Zoom desktop app: meeting window or Meeting menu', { skip }, async () => {
  const byWindow = await observe('us.zoom.xos', N('AXApplication', {}, [N('AXWindow', { title: 'Zoom Meeting' }), N('AXWindow', { title: 'Q3 planning' })]));
  assert.equal(byWindow[0].platform, 'zoom');
  assert.equal(byWindow[0].title, 'Q3 planning');

  const byMenu = await observe('us.zoom.xos', N('AXApplication', {}, [
    N('AXMenuBar', {}, [N('AXMenuBarItem', { title: 'zoom.us' }), N('AXMenuBarItem', { title: 'Meeting' })]),
    N('AXWindow', { title: 'Zoom Workplace' })]));
  assert.equal(byMenu[0].live, true);

  const home = await observe('us.zoom.xos', N('AXApplication', {}, [
    N('AXMenuBar', {}, [N('AXMenuBarItem', { title: 'zoom.us' })]), N('AXWindow', { title: 'Zoom Workplace' })]));
  assert.deepEqual(home, []);
});

test('Zoom web client in Chrome', { skip }, async () => {
  const r = await observe('com.google.Chrome', chrome(
    meetWindow('https://app.zoom.us/wc/81234567890/start', 'Zoom - Google Chrome', [button('Leave')])));
  assert.equal(r[0].platform, 'zoom');
  assert.equal(r[0].key, 'zoom-web:81234567890');
  assert.equal(r[0].live, true);
});

test('Teams desktop app and Teams web', { skip }, async () => {
  const app = await observe('com.microsoft.teams2', N('AXApplication', {}, [
    N('AXWindow', { title: 'Design review | Microsoft Teams' }, [button('Leave (⌘⇧H)'), button('Mute')])]));
  assert.equal(app[0].platform, 'teams');
  assert.equal(app[0].live, true);

  const chat = await observe('com.microsoft.teams2', N('AXApplication', {}, [
    N('AXWindow', { title: 'Chat | Microsoft Teams' }, [button('New chat')])]));
  assert.deepEqual(chat, []);

  const web = await observe('com.google.Chrome', chrome(
    meetWindow('https://teams.microsoft.com/v2/?meetingjoin=true', 'Standup | Microsoft Teams - Google Chrome', [button('Hang up')])));
  assert.equal(web[0].platform, 'teams');
  assert.equal(web[0].live, true);
});

test('participants are read from the Participants panel', { skip }, async () => {
  const panel = N('AXList', { desc: 'Participants' }, [
    N('AXGroup', { subrole: 'AXListItem' }, [text('Ana Ruiz (Host)'), N('AXImage', { desc: 'Active speaker' })]),
    N('AXGroup', { subrole: 'AXListItem' }, [text('Ben Okafor')]),
    N('AXGroup', { subrole: 'AXListItem' }, [text('Cleo (You)')]),
  ]);
  const r = await observe('com.google.Chrome', chrome(
    meetWindow('https://meet.google.com/abc-defg-hij', 'x - Google Chrome', [button('Leave call'), panel])));
  assert.deepEqual(r[0].participants, [
    { name: 'Ana Ruiz', isHost: true, speaking: true },
    { name: 'Ben Okafor', isHost: false, speaking: false },
    { name: 'Cleo', isHost: false, speaking: false },
  ]);
});

test('participants from video tiles when the People panel is closed (shape taken from a real Meet dump)', { skip }, async () => {
  const tile = (name) => N('AXGroup', {}, [N('AXGroup', {}, [N('AXGroup', {}, [text(name)])])]);
  const meet = (tiles) => chrome(meetWindow('https://meet.google.com/meet/byz-zpua-dkk', 'Meet – byz-zpua-dkk - Google Chrome – Alok', [
    N('AXGroup', {}, [text('09:40'), text('byz-zpua-dkk'), button('Leave call'), N('AXPopUpButton', { title: 'People' })]),
    N('AXGroup', { subrole: 'AXLandmarkMain' }, tiles),
    text('Your microphone is turned off.'),
  ]));
  const alone = await observe('com.google.Chrome', meet([tile('Alok Fitness')]));
  assert.deepEqual(alone[0].participants.map((p) => p.name), ['Alok Fitness']);

  const group = await observe('com.google.Chrome', meet([tile('You'), tile('Ana Ruiz'), tile('Ben Okafor (Host)'), tile('Ana Ruiz'), tile('Ana Ruiz is presenting'), tile('10:15')]));
  assert.deepEqual(group[0].participants, [
    { name: 'You', isHost: false, speaking: false },
    { name: 'Ana Ruiz', isHost: false, speaking: false },
    { name: 'Ben Okafor', isHost: true, speaking: false },
  ]);
});

test('Meet tiles: the speaking classes decoded from the reference SDK mark only the tile that holds them', { skip }, async () => {
  const tile = (name, extra = []) => N('AXGroup', {}, [N('AXGroup', {}, [N('AXGroup', {}, [text(name)])]), ...extra]);
  const speakingMark = N('AXGroup', { domClass: 'koV58 kssMZb' }, [N('AXGroup', { domClass: 'fdKMD' })]);
  const mutedMark = N('AXGroup', { domClass: 'JHK7jb Nep7Ue FTMc0c iPFm3e' });
  const call = (tiles) => chrome(meetWindow('https://meet.google.com/meet/byz-zpua-dkk', 'Meet - Google Chrome', [
    button('Leave call'), N('AXGroup', { subrole: 'AXLandmarkMain' }, [N('AXGroup', {}, tiles)]),
  ]));
  const r = await observe('com.google.Chrome', call([tile('You', [mutedMark]), tile('Ana Ruiz', [speakingMark]), tile('Ben Okafor')]));
  assert.deepEqual(r[0].participants.map((p) => [p.name, p.speaking]), [['You', false], ['Ana Ruiz', true], ['Ben Okafor', false]]);

  const silent = await observe('com.google.Chrome', call([tile('You', [mutedMark]), tile('Ana Ruiz'), tile('Ben Okafor')]));
  assert.ok(silent[0].participants.every((p) => !p.speaking));

  const alone = await observe('com.google.Chrome', call([tile('Alok Fitness', [speakingMark])]));
  assert.deepEqual(alone[0].participants.map((p) => [p.name, p.speaking]), [['Alok Fitness', true]]);
});

test('detector: detect, update, close after missed polls, close at once on the after-call screen', { skip }, async () => {
  const events = [];
  for (const type of ['meeting-detected', 'meeting-updated', 'meeting-closed']) sdk.addEventListener(type, (e) => events.push([type, e.window]));
  const meet = { platform: 'google-meet', key: 'google-meet:abc-defg-hij', bundleId: 'com.google.Chrome', title: 'Sync', url: 'https://meet.google.com/abc-defg-hij' };
  const step = (o) => sdk._debug('debugApply', { observations: o ? [o] : [] });

  await step({ ...meet, live: true });
  await step({ ...meet, live: true });                  // same meeting, nothing new
  await step({ ...meet, live: true, title: 'Renamed' });
  assert.deepEqual(events.map((e) => e[0]), ['meeting-detected', 'meeting-updated']);
  assert.equal(events[0][1].platform, 'google-meet');
  assert.equal(events[0][1].id, events[1][1].id);       // stable id across polls

  await step(null); await step(null);                   // two misses: still open
  assert.equal(events.length, 2);
  await step({ ...meet, live: true, title: 'Renamed' }); // seen again: counter resets
  await step(null); await step(null);
  assert.equal(events.length, 2);
  await step(null);                                     // third miss in a row
  assert.deepEqual(events.map((e) => e[0]).slice(2), ['meeting-closed']);

  events.length = 0;
  await step({ ...meet, key: 'google-meet:zzz-zzzz-zzz', live: true });
  await step({ ...meet, key: 'google-meet:zzz-zzzz-zzz', live: false, afterCall: true });
  assert.deepEqual(events.map((e) => e[0]), ['meeting-detected', 'meeting-closed']);
});

test('participant tracker: join, speech, update, leave only after repeated misses', { skip }, async () => {
  const a = { name: 'Ana', isHost: false, speaking: false };
  const polls = [
    [a],
    [{ ...a, speaking: true }, { name: 'Ben', isHost: false, speaking: false }],
    [{ ...a, speaking: false, isHost: true }, { name: 'Ben', isHost: false, speaking: false }],
    [{ ...a, isHost: true }],          // Ben missing 1
    [{ ...a, isHost: true }],          // 2
    [{ ...a, isHost: true }],          // 3 -> leave
  ];
  const changes = await sdk._debug('debugTrack', { polls });
  assert.deepEqual(changes.map((c) => `${c.event}:${c.name}`), [
    'join:Ana', 'speech_on:Ana', 'join:Ben', 'update:Ana', 'speech_off:Ana', 'leave:Ben',
  ]);
  assert.deepEqual(changes.filter((c) => c.name === 'Ana').map((c) => c.id), [1, 1, 1, 1]);
});

test('speech hold: a flicker between words is not a stop and a start', { skip }, async () => {
  const a = (speaking) => ({ name: 'Ana', isHost: false, speaking });
  // polls are 0.5s apart; the mark drops for one poll in the middle, then for good
  const polls = [[a(false)], [a(true)], [a(false)], [a(true)], [a(false)], [a(false)], [a(false)], [a(false)]];
  const names = (c) => c.map((x) => x.event).join(',');
  assert.equal(names(await sdk._debug('debugTrack', { polls })), 'join,speech_on,speech_off,speech_on,speech_off');
  assert.equal(names(await sdk._debug('debugTrack', { polls, speechHold: 1.2 })), 'join,speech_on,speech_off');
});
