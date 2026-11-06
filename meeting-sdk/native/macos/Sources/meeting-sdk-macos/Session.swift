import Foundation
import AppKit

/// One active recording: the recorder, the participant tracker, and the events that go with them.
final class RecordingSession {
    let recorder: Recorder
    let window: [String: Any]
    let meeting: MeetingWindow?
    let uploadToken: String
    let apiUrl: String
    private let tracker = ParticipantTracker(speechHold: 1.2)
    private var timer: DispatchSourceTimer?
    private let started = Date()

    init(recorder: Recorder, window: [String: Any], meeting: MeetingWindow?, uploadToken: String, apiUrl: String) {
        self.recorder = recorder; self.window = window; self.meeting = meeting; self.uploadToken = uploadToken; self.apiUrl = apiUrl
    }

    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f
    }()

    /// Reads the participants list on a timer and reports joins, leaves, updates and speech changes.
    func startParticipantPolling(interval: TimeInterval = 0.5) {
        guard let meeting else { return }
        let t = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "meeting-sdk.participants"))
        t.schedule(deadline: .now() + interval, repeating: interval)
        t.setEventHandler { [weak self] in self?.pollParticipants(meeting) }
        t.resume()
        timer = t
    }

    func stopParticipantPolling() { timer?.cancel(); timer = nil }

    private func pollParticipants(_ meeting: MeetingWindow) {
        let tree = AX.snapshot(pid: meeting.pid, windowContaining: meeting.title)
        guard let scope = Rules.observe(bundleId: meeting.bundleId, app: tree).first(where: { $0.key == meeting.key })?.scope else { return }
        for change in tracker.update(ParticipantRules.scrape(scope)) { emit(change) }
    }

    func emit(_ change: ParticipantTracker.Change) {
        let participant: [String: Any] = [
            "id": change.id, "name": change.obs.name, "is_host": change.obs.isHost,
            "platform": meeting?.platform.rawValue ?? "unknown", "extra_data": NSNull(), "email": NSNull(),
        ]
        let data: [String: Any] = [
            "participant": participant,
            "timestamp": ["absolute": Self.iso.string(from: change.at), "relative": change.at.timeIntervalSince(started)],
        ]
        let event = "participant_events.\(change.event)"
        Wire.emit("realtime-event", ["window": window, "event": event, "data": ["data": data]])
        Uploader.postEvent(apiUrl: apiUrl, token: uploadToken, body: ["event": event, "data": data])
    }
}

/// Owns detection and recordings and implements the recording commands.
final class App {
    let detector = Detector()
    var apiUrl = "https://api.example.com"
    private var sessions: [String: RecordingSession] = [:]
    private var desktopSources: Set<String> = []

    func configure(_ config: [String: Any]) {
        if let u = (config["api_url"] as? String) ?? (config["apiUrl"] as? String) { apiUrl = u }
        if let p = config["pollInterval"] as? Double { detector.pollInterval = p }
        if let n = config["nilPollThreshold"] as? Int { detector.nilPollThreshold = n }
    }

    func prepareDesktopAudio() -> String {
        let id = "desktop-" + UUID().uuidString
        desktopSources.insert(id)
        return id
    }

    func startRecording(windowId: String, uploadToken: String, respond: @escaping (String?) -> Void) {
        if sessions[windowId] != nil { respond("\(windowId) is already being recorded"); return }
        guard CGPreflightScreenCaptureAccess() else { respond("screen-capture permission is not granted"); return }

        let windowJSON: [String: Any]
        let meeting: MeetingWindow?
        let recorder: Recorder
        if desktopSources.contains(windowId) {
            windowJSON = ["id": windowId]
            meeting = nil
            recorder = Recorder(windowId: windowId, windowJSON: windowJSON, pid: nil)
        } else if let m = detector.window(id: windowId) {
            windowJSON = m.json
            meeting = m
            recorder = Recorder(windowId: windowId, windowJSON: windowJSON, pid: m.pid,
                                titleHints: [m.windowTitle, m.title].compactMap { $0 })
        } else {
            respond("Unknown window \(windowId)"); return
        }

        // Starting a different recording stops the active one.
        for (id, s) in sessions where id != windowId { stop(id, session: s) }

        let session = RecordingSession(recorder: recorder, window: windowJSON, meeting: meeting, uploadToken: uploadToken, apiUrl: apiUrl)
        sessions[windowId] = session
        recorder.onCapture = { kind in
            Wire.emit("media-capture-status", ["window": windowJSON, "type": kind, "capturing": true])
        }
        recorder.onError = { message in
            Wire.emit("error", ["window": windowJSON, "type": "recording", "message": message])
        }
        respond(nil)
        Task {
            do {
                try await recorder.start()
                Wire.emit("recording-started", ["window": windowJSON, "rawMedia": false])
                session.startParticipantPolling()
            } catch {
                self.sessions[windowId] = nil
                Wire.emit("error", ["window": windowJSON, "type": "recording", "message": "\(error)"])
            }
        }
    }

    func stopRecording(windowId: String) {
        guard let session = sessions[windowId] else { return }
        stop(windowId, session: session)
    }

    private func stop(_ windowId: String, session: RecordingSession) {
        sessions[windowId] = nil
        session.stopParticipantPolling()
        Task {
            let file = await session.recorder.stop()
            for kind in ["video", "audio"] where !(kind == "video" && session.recorder.audioOnly) {
                Wire.emit("media-capture-status", ["window": session.window, "type": kind, "capturing": false])
            }
            Wire.emit("recording-ended", ["window": session.window])
            guard let file else {
                Wire.emit("error", ["window": session.window, "type": "recording", "message": "no media was captured"])
                return
            }
            do { try await Uploader.upload(file: file, apiUrl: session.apiUrl, token: session.uploadToken); try? FileManager.default.removeItem(at: file) }
            catch { Wire.emit("error", ["window": session.window, "type": "upload", "message": "\(error); the file is kept at \(file.path)"]) }
        }
    }

    func pause(windowId: String) { sessions[windowId]?.recorder.pause() }
    func resume(windowId: String) { sessions[windowId]?.recorder.resume() }
    func isRecording(_ windowId: String) -> Bool { sessions[windowId] != nil }
}
