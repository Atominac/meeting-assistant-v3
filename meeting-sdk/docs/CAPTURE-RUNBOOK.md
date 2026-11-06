# Capture runbook: checking the rules against real calls

Do this once per platform: Meet in Chrome, Zoom app, Zoom web, Teams app, Teams web. You need a second person (or device) to join.

Setup: grant Accessibility and Screen Recording to your terminal. Chrome: enable accessibility
(chrome://accessibility, "Native accessibility API support").

For each platform, at each step below, run:

```sh
node tools/ax-dump.mjs tree "<app name>" out/<platform>-<step>/
```

Steps: 1 app open, no call. 2 lobby / pre-join. 3 in call, alone. 4 second person joined. 5 second person speaking.
6 participants panel open. 7 someone shares their screen. 8 you share your screen. 9 window minimized.
10 you leave (after-call screen). 11 the other person leaves.

In parallel, record the reference SDK's events for the same call (it must be running in your app):

```sh
TAP_OUT=$PWD/re/notes/trace-<platform>.jsonl node -r ./re/tap/tap.cjs <your script that inits the reference SDK>
```

Then compare: the dumps show what our rules must match (button labels, URL, title, panel layout), and the trace shows which
events the reference SDK emitted at each step and when. Turn each dump into a test fixture in `test/fixtures/` and run
it through `debugObserve`. Fix the rules in `native/macos/Sources/meeting-sdk-macos/Rules.swift` and `Participants.swift`
until the output equals the reference.
