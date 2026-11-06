# Plan

Goal: the same functionality and API as the reference desktop SDK. Server side is mocked.

Method: decompile and trace the reference SDK, write a spec per module, rebuild, then prove it matches by
running both SDKs on the same meetings and diffing the event streams.

## Status

Windows is out of scope for now. "Verified" means checked by a test or a live run on this Mac; "unverified" means written
from the reference SDK's strings and behaviour but not yet checked against a live call.

| Area | State |
|---|---|
| Contract, wrapper, wire protocol, mock server | Done and tested |
| Permission reporting and prompts | Done (4 of 8 are real checks; the rest say `not_requested`) |
| Accessibility dump tools | Done, run on Finder |
| Platform detection and live-call rules: Meet, Zoom app, Zoom web, Teams app, Teams web | Written; logic tested on synthetic trees; **selectors unverified** |
| Detector: detect, update, close after N missed polls, close on after-call screen, mic veto | Done; logic tested; a live scan with Chrome and Zoom open found no false meeting |
| Recording: window video + meeting audio + mic to MP4, pause, resume, upload to the mock server | Written and compiled; **not run end to end**, because this Mac has not granted Screen Recording to the test process |
| Desktop-audio (in-person) recording | Written; same limit as above |
| Participants: join, leave, update, speech on/off with timestamps, as `realtime-event` | Written; tracker tested; **panel scraping unverified** |
| Chat message, Raw Media | Refused with the reference SDK's wording (needs Raw Media) |
| Windows | Not started |

### Known gaps against the reference SDK

- No screen-share detection or per-tile video (we record the whole meeting window; the reference builds a gallery).
- Meeting audio and microphone are separate audio tracks, not one mixed track. Meeting audio comes from ScreenCaptureKit, not a CoreAudio process tap. The microphone needs macOS 15 or later.
- Upload happens when recording stops, not during the call.
- No Safari-specific or Arc/Dia after-call logic, no IndexedDB or AppleScript probes, no Zoom web gallery paging, no Slack Huddles.
- No `network-status`, `zoom-computer-audio`, `compliance-message-status` or `provider-error` events.
- Poll interval (2 s) and miss threshold (3) are defaults, not measured values.

## Phases

**Phase 1: ground truth.** Run the reference SDK under the tap during real calls (Meet, Zoom app, Zoom web, Teams app,
Teams web): lobby, join, speaking, screen share, minimize, leave. Save the traces and an accessibility dump at each
step. These become the spec and the replay fixtures.

**Phase 2: macOS detection.** App watcher (NSWorkspace), platform from app ID, tab address and window title,
"live call" rules per platform, end of meeting with a missed-check counter, the after-call screen and the microphone veto.
Poll intervals and thresholds are taken from the traces, not guessed.

**Phase 3: macOS recording.** ScreenCaptureKit window capture, CoreAudio process tap for the meeting audio (macOS 14.2+),
microphone, mix, MP4 (AVAssetWriter), chunked upload to the mock server.

**Phase 4: participants.** Tiles and names from the accessibility tree, diff over time for joined/left/updated with
timestamps, active speaker, camera, screen share.

**Phase 5: Windows.** Same spec with UI Automation, Windows Graphics Capture and WASAPI per-process loopback.

**Phase 6: keep it matching.** Remote selector config, a daily job that runs both SDKs against current Zoom, Meet and
Teams builds and alerts on any event-stream diff.

## Open decisions

1. Copy the Zoom scraping scripts the reference SDK downloads at runtime, or write our own.
2. Raw Media mode (needs Zoom partner access): leave out at first.
3. fd 3 for the data channel on macOS, as the reference does.

## How "the same" is checked

Replay tests feed recorded accessibility sequences into our code and compare the events with the reference's.
Side-by-side runs use both SDKs on one live meeting and diff the event streams and the recordings.
