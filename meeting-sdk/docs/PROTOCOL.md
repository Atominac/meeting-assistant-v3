# Wire protocol (observed)

Between the Node wrapper and the native helper. Source of truth: `re/notes/trace-startup.jsonl`, recorded with
`re/tap/tap.cjs` against the reference SDK 2.0.42. Re-record with:

```sh
TAP_OUT=$PWD/re/notes/trace-startup.jsonl perl -e 'alarm 30; exec @ARGV' \
  node -r ./re/tap/tap.cjs re/tap/probe-original.cjs <path to reference SDK package> < /dev/null
```

## Framing

- Wrapper to helper, on stdin: one JSON object per line: `{"command", "commandId", "writeSequence", "params"}`.
  `commandId` is a UUID. `writeSequence` counts up from 1.
- Helper to wrapper: lines starting with a fixed prefix, then JSON.
  - Reference SDK: prefix `recall_ai_command|`, sent on stdout, and on **fd 3** on macOS.
  - This SDK: prefix `msdk|`, sent on stdout only. (fd 3 keeps native log noise off the data channel; add it if stdout pollution becomes a problem.)
- Response: `{"type":"response","commandId","status":"success"|"error","result"}`. For errors `result` is the message.
- Event: `{"type":"event","event":"<JSON string>"}` where the inner JSON is `{"type": <event name>, "payload": {...}}`.
- Keys are sorted alphabetically by the reference helper; this does not matter to the wrapper.

## Commands

`init` (`params.config` is a JSON string), `shutdown`, `startRecording` (`params.config` is a JSON string), `stopRecording`,
`pauseRecording`, `resumeRecording`, `sendChatMessage`, `uploadRecording`, `prepareDesktopAudioRecording`,
`listDevices`, `setDesktopAudioDevice`, `requestPermission`, `dumpAXTree`, `dumpAllApplications`,
`unexpectedShutdown`, `log`.

## Observed startup sequence

1. wrapper sends `init`.
2. About 0.3 s later the helper emits eight `permission-status` events, in this order: accessibility, microphone,
   screen-capture, system-audio, full-disk-access, teams-automation, browser-automation, zoom-raw-media.
   This happens even when `acquirePermissionsOnStartup` is empty.
   - Not requested: `{granted:false, status:"not_requested"}`.
   - `teams-automation` is `not_installed` when Teams is absent.
3. About 1.3 s after `init`, the helper sends the `init` response (`result: null`). The response comes **after** the events.
4. `shutdown` is answered at once with `result: null`, then the process exits with code 0.

## Not yet traced

Meeting detection events, `startRecording` and everything during a recording. These need real meetings
(see docs/PLAN.md, Phase 1).
