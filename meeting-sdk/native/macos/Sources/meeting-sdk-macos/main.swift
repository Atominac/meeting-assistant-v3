import Foundation
import AppKit

setvbuf(stdout, nil, _IOLBF, 0)

// Connect to the window server. ScreenCaptureKit and CoreGraphics abort the process (CGS_REQUIRE_INIT) when a
// command-line program has not done this. No Dock icon: the activation policy is "prohibited".
_ = NSApplication.shared
NSApp.setActivationPolicy(.prohibited)

/// Commands run on a serial queue so responses keep command order; permission prompts may complete later.
let queue = DispatchQueue(label: "meeting-sdk.commands")
let app = App()
var initConfig: [String: Any] = [:]

func jsonObject(_ raw: Any?) -> [String: Any]? {
    guard let s = raw as? String, let d = s.data(using: .utf8) else { return nil }
    return try? JSONSerialization.jsonObject(with: d) as? [String: Any]
}

func handle(_ command: String, id: String, params: [String: Any]) {
    switch command {
    case "init":
        if let config = jsonObject(params["config"]) { initConfig = config; app.configure(config) }
        let requested = (initConfig["acquirePermissionsOnStartup"] as? [String]) ?? []
        let group = DispatchGroup()
        for permission in requested where Permissions.startupAllowed.contains(permission) {
            group.enter()
            Permissions.request(permission) { group.leave() }
        }
        group.wait()
        for permission in Permissions.all { Permissions.emitStatus(permission) }
        if !requested.isEmpty && requested.allSatisfy({ Permissions.status($0).status == "granted" }) {
            Wire.emit("permissions-granted", [:])
        }
        Wire.respond(id, result: nil)
        if initConfig["disableDetection"] as? Bool != true { app.detector.start() }

    case "shutdown":
        app.detector.stop()
        Wire.respond(id, result: nil)
        exit(0)

    case "unexpectedShutdown":
        exit(1)

    case "requestPermission":
        guard let permission = params["permission"] as? String else { Wire.fail(id, "permission is required"); return }
        Permissions.request(permission) {
            Permissions.emitStatus(permission)
            Wire.respond(id, result: nil)
        }

    case "dumpAllApplications":
        Wire.respond(id, result: AXDump.applications())

    case "dumpAXTree":
        guard let name = params["procName"] as? String else { Wire.fail(id, "procName is required"); return }
        let apps = AXDump.findApps(matching: name)
        guard !apps.isEmpty else { Wire.fail(id, "No running process matches \(name)"); return }
        let result = apps.map { a -> [String: Any] in
            if let b = a.bundleIdentifier, Rules.chromiumBundles.contains(b) { AX.enableChromiumAccessibility(pid: a.processIdentifier) }
            return ["pid": Int(a.processIdentifier), "tree": AX.snapshot(pid: a.processIdentifier).render()]
        }
        Wire.respond(id, result: result)

    case "startRecording":
        guard let config = jsonObject(params["config"]), let windowId = config["windowId"] as? String,
              let token = config["uploadToken"] as? String, !token.isEmpty else {
            Wire.fail(id, "windowId and uploadToken are required"); return
        }
        app.startRecording(windowId: windowId, uploadToken: token) { error in
            if let error { Wire.fail(id, error) } else { Wire.respond(id, result: nil) }
        }

    case "stopRecording":
        if let windowId = params["windowId"] as? String { app.stopRecording(windowId: windowId) }
        Wire.respond(id, result: nil)

    case "pauseRecording":
        if let windowId = params["windowId"] as? String { app.pause(windowId: windowId) }
        Wire.respond(id, result: nil)

    case "resumeRecording":
        if let windowId = params["windowId"] as? String { app.resume(windowId: windowId) }
        Wire.respond(id, result: nil)

    case "uploadRecording":
        Wire.respond(id, result: nil)   // deprecated no-op in the contract

    case "prepareDesktopAudioRecording":
        Wire.respond(id, result: app.prepareDesktopAudio())

    case "sendChatMessage":
        // Chat messages need Raw Media, which this SDK does not have.
        Wire.fail(id, "sendChatMessage is only available for Raw Media recordings")

    case "listDevices", "setDesktopAudioDevice":
        Wire.fail(id, "\(command) is only available on Windows")

    case "debugObserve":
        // Test hook: run the detection rules on a recorded tree. params: bundleId, tree (JSON string).
        guard let bundle = params["bundleId"] as? String, let raw = params["tree"] as? String,
              let data = raw.data(using: .utf8), let tree = try? JSONDecoder().decode(AXNode.self, from: data) else {
            Wire.fail(id, "bundleId and a valid tree are required"); return
        }
        let result = Rules.observe(bundleId: bundle, app: tree).map { o -> [String: Any] in
            var r: [String: Any] = ["platform": o.platform.rawValue, "key": o.key, "live": o.live, "afterCall": o.afterCall]
            if let t = o.title { r["title"] = t }
            if let u = o.url { r["url"] = u }
            if let s = o.scope { r["participants"] = ParticipantRules.scrape(s).map { ["name": $0.name, "isHost": $0.isHost, "speaking": $0.speaking] } }
            return r
        }
        Wire.respond(id, result: result)

    case "debugApply":
        // Test hook: feed observations to the detector (use with init config disableDetection:true).
        let list = (params["observations"] as? [[String: Any]]) ?? []
        let observations = list.compactMap { o -> (Observation, pid_t)? in
            guard let p = (o["platform"] as? String).flatMap(Platform.init(rawValue:)), let key = o["key"] as? String else { return nil }
            return (Observation(platform: p, key: key, title: o["title"] as? String, url: o["url"] as? String,
                                bundleId: (o["bundleId"] as? String) ?? "test", live: (o["live"] as? Bool) ?? true,
                                afterCall: (o["afterCall"] as? Bool) ?? false), 0)
        }
        app.detector.apply(observations)
        Wire.respond(id, result: nil)

    case "debugTrack":
        // Test hook: run successive participant scrapes through the tracker and return the changes.
        let polls = (params["polls"] as? [[[String: Any]]]) ?? []
        let hold = params["speechHold"] as? Double ?? 0
        let tracker = ParticipantTracker(speechHold: hold)
        var out: [[String: Any]] = []
        var clock = Date(timeIntervalSince1970: 0)
        for poll in polls {
            clock = clock.addingTimeInterval(0.5)
            let obs = poll.map { ParticipantObs(name: $0["name"] as? String ?? "", isHost: $0["isHost"] as? Bool ?? false, speaking: $0["speaking"] as? Bool ?? false) }
            for c in tracker.update(obs, at: clock) { out.append(["event": c.event, "id": c.id, "name": c.obs.name]) }
        }
        Wire.respond(id, result: out)

    case "debugScrape":
        // Test hook: read the participants of every meeting currently on screen, as a recording would.
        var result: [[String: Any]] = []
        for (obs, pid) in app.detector.scan() {
            let people = obs.scope.map { ParticipantRules.scrape($0) } ?? []
            var entry: [String: Any] = ["key": obs.key, "live": obs.live, "participants": people.map { ["name": $0.name, "isHost": $0.isHost, "speaking": $0.speaking] }]
            if params["timing"] as? Bool == true {
                let t0 = Date(); _ = AX.snapshot(pid: pid); let full = Date().timeIntervalSince(t0)
                let t1 = Date(); _ = AX.snapshot(pid: pid, windowContaining: obs.title); entry["ms"] = ["full": Int(full * 1000), "scoped": Int(Date().timeIntervalSince(t1) * 1000)]
            }
            if params["classes"] as? Bool == true, let scope = obs.scope {
                entry["tiles"] = ParticipantRules.tileList(scope).map { ["name": $0.name, "classes": ParticipantRules.classes(in: $0.root)] as [String: Any] }
            }
            result.append(entry)
        }
        Wire.respond(id, result: result)

    case "debugPostEvent":
        // Test hook: send a participant event through the real uploader and report the HTTP status.
        guard let apiUrl = params["apiUrl"] as? String, let token = params["token"] as? String else { Wire.fail(id, "apiUrl and token are required"); return }
        Uploader.postEvent(apiUrl: apiUrl, token: token, body: ["event": "participant_events.join", "data": ["participant": ["id": 1, "name": "Test"], "timestamp": ["relative": 1.5, "absolute": "2026-01-01T00:00:00Z"]]]) { Wire.respond(id, result: $0) }

    case "debugDisplays":
        // Test hook: a CoreGraphics call that crashes the process if the window-server connection is missing.
        var ids = [CGDirectDisplayID](repeating: 0, count: 8)
        var count: UInt32 = 0
        CGGetDisplaysWithRect(CGRect(x: 100, y: 100, width: 800, height: 600), 8, &ids, &count)
        Wire.respond(id, result: Int(count))

    case "log":
        Wire.respond(id, result: nil)

    default:
        Wire.fail(id, "\(command) is not implemented")
    }
}

app.detector.onClosed = { _ in }

let reader = Thread {
    while let line = readLine(strippingNewline: true) {
        guard let data = line.data(using: .utf8),
              let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let command = message["command"] as? String,
              let id = message["commandId"] as? String else { continue }
        let params = message["params"] as? [String: Any] ?? [:]
        queue.async { handle(command, id: id, params: params) }
    }
    exit(0)   // stdin closed: the wrapper is gone
}
reader.start()
RunLoop.main.run()
