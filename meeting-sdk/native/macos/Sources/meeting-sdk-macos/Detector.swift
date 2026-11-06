import Foundation
import AppKit
import CoreAudio
import Darwin

/// One detected meeting as the SDK reports it to the app.
struct MeetingWindow {
    var id: String
    var key: String
    var platform: Platform
    var title: String?
    var url: String?
    var bundleId: String
    var pid: pid_t
    var windowTitle: String?
    var nilPolls = 0

    var json: [String: Any] {
        var w: [String: Any] = ["id": id, "platform": platform.rawValue, "process_name": bundleId]
        if let title { w["title"] = title }
        if let url { w["url"] = url }
        return w
    }
}

/// True when any process of the app (including browser helper processes) is capturing the microphone. Used to
/// stop a meeting being closed because one scan failed to see it.
enum Mic {
    private static func isRunningInput(_ pid: pid_t) -> Bool {
        var pid = pid
        var translate = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
                                                   mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var object = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &translate,
                                         UInt32(MemoryLayout<pid_t>.size), &pid, &size, &object) == noErr,
              object != kAudioObjectUnknown else { return false }
        var running = UInt32(0)
        var runSize = UInt32(MemoryLayout<UInt32>.size)
        var address = AudioObjectPropertyAddress(mSelector: kAudioProcessPropertyIsRunningInput,
                                                 mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectGetPropertyData(object, &address, 0, nil, &runSize, &running) == noErr else { return false }
        return running != 0
    }

    private static func children(of pid: pid_t) -> [pid_t] {
        var buffer = [pid_t](repeating: 0, count: 512)
        let bytes = proc_listchildpids(pid, &buffer, Int32(buffer.count * MemoryLayout<pid_t>.size))
        guard bytes > 0 else { return [] }
        return Array(buffer.prefix(Int(bytes) / MemoryLayout<pid_t>.size)).filter { $0 > 0 }
    }

    static func inUse(byAppWithPid pid: pid_t) -> Bool {
        var all: [pid_t] = [pid]
        var frontier: [pid_t] = [pid]
        for _ in 0..<3 { frontier = frontier.flatMap(children(of:)); all += frontier }
        return all.contains(where: isRunningInput)
    }
}

/// Polls the running meeting apps and turns what it sees into meeting-detected / -updated / -closed events.
final class Detector {
    var pollInterval: TimeInterval = 2
    /// A meeting must be missing this many polls in a row before it is closed.
    var nilPollThreshold = 3
    private(set) var windows: [String: MeetingWindow] = [:]   // by key
    private let queue = DispatchQueue(label: "meeting-sdk.detector")
    private var timer: DispatchSourceTimer?
    private var enabled = true

    func start() {
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 0.5, repeating: pollInterval)
        t.setEventHandler { [weak self] in self?.poll() }
        t.resume()
        timer = t
    }

    func stop() { timer?.cancel(); timer = nil }

    func window(id: String) -> MeetingWindow? { queue.sync { windows.values.first { $0.id == id } } }

    func scan() -> [(Observation, pid_t)] {
        var found: [(Observation, pid_t)] = []
        for app in NSWorkspace.shared.runningApplications {
            guard let bundle = app.bundleIdentifier, Rules.watchedBundles.contains(bundle), !app.isTerminated else { continue }
            if Rules.chromiumBundles.contains(bundle) { AX.enableChromiumAccessibility(pid: app.processIdentifier) }
            let tree = AX.snapshot(pid: app.processIdentifier)
            for obs in Rules.observe(bundleId: bundle, app: tree) { found.append((obs, app.processIdentifier)) }
        }
        return found
    }

    func poll() {
        guard AXIsProcessTrusted() else { return }
        let started = Date()
        let found = scan()
        if debug {
            let summary = found.map { "\($0.0.key) live=\($0.0.live) afterCall=\($0.0.afterCall)" }.joined(separator: "; ")
            Wire.log("poll \(String(format: "%.2f", Date().timeIntervalSince(started)))s: \(summary.isEmpty ? "nothing" : summary)")
        }
        apply(found)
    }

    private let debug = ProcessInfo.processInfo.environment["MSDK_DEBUG"] != nil

    /// Separate from `poll` so tests can feed observations without a live app.
    func apply(_ observations: [(Observation, pid_t)]) {
        var liveKeys = Set<String>()
        var afterCallKeys = Set<String>()
        for (obs, pid) in observations {
            if obs.afterCall { afterCallKeys.insert(obs.key) }
            guard obs.live else { continue }
            liveKeys.insert(obs.key)
            if var w = windows[obs.key] {
                w.nilPolls = 0
                let changed = (obs.title != nil && obs.title != w.title) || (obs.url != nil && obs.url != w.url)
                if let t = obs.title { w.title = t }
                if let u = obs.url { w.url = u }
                w.pid = pid
                if let t = obs.windowTitle { w.windowTitle = t }
                windows[obs.key] = w
                if changed { Wire.emit("meeting-updated", ["window": w.json]) }
            } else {
                let w = MeetingWindow(id: UUID().uuidString, key: obs.key, platform: obs.platform, title: obs.title,
                                      url: obs.url, bundleId: obs.bundleId, pid: pid, windowTitle: obs.windowTitle)
                windows[obs.key] = w
                Wire.emit("meeting-detected", ["window": w.json])
            }
        }
        for (key, var w) in windows where !liveKeys.contains(key) {
            if afterCallKeys.contains(key) { if debug { Wire.log("close \(key): after-call screen") }; close(key); continue }
            // The app may be using the mic even when this scan could not read the meeting window.
            if Mic.inUse(byAppWithPid: w.pid) { w.nilPolls = 0; windows[key] = w; continue }
            w.nilPolls += 1
            windows[key] = w
            if debug { Wire.log("miss \(key) \(w.nilPolls)/\(nilPollThreshold)") }
            if w.nilPolls >= nilPollThreshold { if debug { Wire.log("close \(key): missed polls") }; close(key) }
        }
    }

    private func close(_ key: String) {
        guard let w = windows.removeValue(forKey: key) else { return }
        Wire.emit("meeting-closed", ["window": w.json])
        onClosed?(w)
    }

    var onClosed: ((MeetingWindow) -> Void)?
}
