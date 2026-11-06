# Meeting Assistant v3

Records Zoom, Google Meet and Teams calls from a Mac without a bot joining, then gives your team a web page with a video
player, a synced transcript, AI notes, and chat over every meeting. It is built on our own desktop
recording SDK ([../meeting-sdk](../meeting-sdk)) and our own server-side recording pipeline, with no outside recording service.

```
 Mac: desktop/                       Server: server/                           GoHighLevel: web/
 menu-bar app + floating widget  ->  issues upload tokens, stores recordings   ->  React page in an iframe
 detects Zoom / Meet / Teams,        in data/media, transcribes with OpenAI,       Recordings, Calendar, Ask AI,
 records with meeting-desktop-sdk    names speakers from the SDK's events,         Settings (account, devices)
                                     AI notes + chat, Google Calendar
```

## Run it

```bash
cp .env.example .env           # once: fill in MONGODB_URI, DEEPGRAM_API_KEY and OPENAI_API_KEY (notes + chat)
npm start                      # everything: builds what is missing, starts the server, then opens the desktop app
```

`npm start` installs missing dependencies, builds the recording helper (first run, macOS) and the web app, starts the
server on http://localhost:3002, waits until it answers, and opens the desktop app. Ctrl+C stops both. If the server
cannot start (for example the database is unreachable) it says why and does not open the app.
`npm run server` runs the server alone, which is what a deployment uses; `node run-all.mjs --no-desktop` does the same on a dev machine.

Then sign up in the web app, log in from the widget, press **Grant access** (Accessibility, Microphone, Screen
recording), and join a call. A pop-up asks **Record this meeting?**.

Install `ffmpeg` (`brew install ffmpeg`) on the server: it mixes the meeting and microphone audio into one track before
transcription. Without it Deepgram still transcribes (any length) but only hears the first audio track, which is the meeting
audio and not your microphone. With the OpenAI fallback, ffmpeg is also needed for calls longer than about 15 minutes.

## How a recording flows

1. Widget **Record** -> `POST /api/desktop/meetings`. The server matches a calendar event, creates an upload and returns its token.
2. The desktop calls `MeetingSdk.startRecording({ windowId, uploadToken })`. While recording, the SDK posts participant events
   (`participant_events.join`, `leave`, `speech_on`, `speech_off`) to `POST /api/sdk/upload/:token/events`.
3. **Stop** (or the meeting ends) -> the SDK uploads the MP4 to `PUT /api/sdk/upload/:token/media`; the desktop calls
   `POST /api/desktop/meetings/:id/ended`.
4. The server worker sees the finished upload, extracts and mixes the audio, transcribes it, gives each segment to whoever was
   speaking at that time, saves the transcript, then asks OpenAI for notes. The recording appears in the web app.

## Known limits

- **The SDK is not proven on live calls yet.** Detection rules and participant scraping are untested against real Meet, Zoom
  and Teams calls (see ../meeting-sdk/docs/PLAN.md). Expect to tune them. Until then, `npm run demo` exercises everything except detection.
- Speaker names depend on the SDK reading "who is speaking" from the screen. Where it cannot, segments are labelled "Speaker".
- Recordings are uploaded when they stop, not during the call. A crash mid-call loses the recording.
- The recorded video is the meeting window as it looks on screen, not a built gallery.
- Speaker labels: names come from the SDK's "who is speaking" markers; where there are none, Deepgram's own diarization gives "Speaker 1", "Speaker 2".
- No Windows build, no live captions, no Outlook calendar.
- The `data/` folder is the long-term store for recordings. Back it up or move it to object storage.
- Chat sends the transcript (or, across meetings, summaries plus the best-matching excerpts) to OpenAI's API.

## Accounts, GoHighLevel, Google Calendar

Email + password with revocable sessions per device (Settings), optional `SIGNUP_CODE`, embedding in an
iframe via `PUBLIC_URL` and `FRAME_ANCESTORS`, and per-user read-only Google Calendar (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`,
redirect URI `PUBLIC_URL/api/calendar/google/callback`). A forgotten password is reset by an admin:
`npm -w server run set-password -- person@example.com 'new password'`. Use HTTPS in production.
