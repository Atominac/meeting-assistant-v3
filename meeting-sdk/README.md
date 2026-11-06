# meeting-sdk

A desktop SDK that detects meetings (Zoom, Google Meet, Microsoft Teams) and records them, with the same
functionality and API as the reference SDK it is modelled on. The server side is mocked.

```
packages/sdk     Node wrapper (public API, same shape as the reference SDK) + index.d.ts contract
native/macos     Swift helper process (Accessibility, ScreenCaptureKit, CoreAudio)
native/windows   Windows helper (planned: UI Automation, Windows Graphics Capture, WASAPI)
mock-server      Stand-in for the upload / token server
re               Reverse-engineering tooling and recorded traces of the reference SDK
tools            Developer tools (accessibility tree dumper)
test             Protocol and behaviour tests
docs             PLAN.md (roadmap and status), PROTOCOL.md (observed wire protocol)
```

## Quick start (macOS)

```sh
native/macos/build.sh                 # builds packages/sdk/bin/meeting-sdk-macos
node --test test/protocol.test.mjs    # wrapper <-> helper handshake test
node tools/ax-dump.mjs apps           # list running apps
node tools/ax-dump.mjs tree "Google Chrome" out/   # dump an app's accessibility tree to a file
node mock-server/server.mjs           # mock upload server on :4010
```

`build.sh` uses the macOS 26 SDK from the Command Line Tools; set `MSDK_SDK` to use another one.
The terminal running the tools needs the Accessibility permission.

## Status

See [docs/PLAN.md](docs/PLAN.md) for what is verified and what is not. In short: the API, protocol, detection rules,
detector, recorder and participant tracking are written and tested on synthetic data. They have not yet been run on a
live call, and recording has not been run end to end. Windows is not built.

To check it on your Mac: grant Screen Recording to the terminal, then `npm test` runs a real 4-second desktop-audio
recording and checks that the file reaches the mock server. Then follow [docs/CAPTURE-RUNBOOK.md](docs/CAPTURE-RUNBOOK.md)
on real calls.
