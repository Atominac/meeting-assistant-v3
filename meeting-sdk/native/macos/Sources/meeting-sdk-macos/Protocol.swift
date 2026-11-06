import Foundation

/// Wire protocol with the Node wrapper: one JSON object per line on stdin, `msdk|`-prefixed JSON lines on stdout.
enum Wire {
    static let prefix = "msdk|"
    private static let lock = NSLock()

    private static func write(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
              let text = String(data: data, encoding: .utf8) else { return }
        lock.lock(); defer { lock.unlock() }
        FileHandle.standardOutput.write(Data((prefix + text + "\n").utf8))
    }

    static func respond(_ commandId: String, result: Any?) {
        write(["type": "response", "commandId": commandId, "status": "success", "result": result ?? NSNull()])
    }

    static func fail(_ commandId: String, _ message: String) {
        write(["type": "response", "commandId": commandId, "status": "error", "result": message])
    }

    /// The event travels as a JSON string inside the envelope, so the wrapper parses it a second time.
    static func emit(_ type: String, _ payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: ["type": type, "payload": payload], options: [.sortedKeys]),
              let text = String(data: data, encoding: .utf8) else { return }
        write(["type": "event", "event": text])
    }

    static func log(_ message: String) {
        FileHandle.standardError.write(Data((message + "\n").utf8))
    }
}
