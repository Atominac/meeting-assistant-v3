import Foundation
import AppKit
import ApplicationServices

/// Diagnostic dumps used to build the detection rules from real meetings (Phase 1 ground truth).
enum AXDump {
    static func applications() -> [[String: Any]] {
        NSWorkspace.shared.runningApplications.map { app in
            var entry: [String: Any] = [
                "pid": Int(app.processIdentifier),
                "activationPolicy": app.activationPolicy == .regular ? "regular" : (app.activationPolicy == .accessory ? "accessory" : "prohibited"),
            ]
            if let id = app.bundleIdentifier { entry["bundleId"] = id }
            if let name = app.localizedName { entry["name"] = name }
            if let url = app.executableURL { entry["executable"] = url.path }
            return entry
        }.sorted { ($0["pid"] as? Int ?? 0) < ($1["pid"] as? Int ?? 0) }
    }

    static func findApps(matching procName: String) -> [NSRunningApplication] {
        let needle = procName.lowercased()
        return NSWorkspace.shared.runningApplications.filter {
            ($0.bundleIdentifier?.lowercased() == needle)
                || ($0.localizedName?.lowercased() == needle)
                || ($0.executableURL?.lastPathComponent.lowercased() == needle)
        }
    }

    private static func copy(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success ? value : nil
    }

    private static func text(_ value: CFTypeRef?) -> String? {
        guard let value else { return nil }
        if let s = value as? String { return s.isEmpty ? nil : s }
        if let n = value as? NSNumber { return n.stringValue }
        if let a = value as? [String] { return a.isEmpty ? nil : a.joined(separator: " ") }
        return nil
    }

    static func tree(pid: pid_t, maxDepth: Int = 14, maxNodes: Int = 6000) -> String {
        let root = AXUIElementCreateApplication(pid)
        var lines: [String] = []
        var count = 0
        func walk(_ element: AXUIElement, _ depth: Int) {
            guard depth <= maxDepth, count < maxNodes else { return }
            count += 1
            var parts = [text(copy(element, kAXRoleAttribute)) ?? "?"]
            if let v = text(copy(element, kAXSubroleAttribute)) { parts.append("subrole=\(v)") }
            for (label, attr) in [("title", kAXTitleAttribute), ("desc", kAXDescriptionAttribute),
                                  ("value", kAXValueAttribute), ("id", "AXIdentifier"),
                                  ("domClass", "AXDOMClassList"), ("domId", "AXDOMIdentifier"),
                                  ("url", kAXURLAttribute)] {
                if var v = text(copy(element, attr)) {
                    if v.count > 160 { v = String(v.prefix(160)) + "…" }
                    parts.append("\(label)=\"\(v)\"")
                }
            }
            lines.append(String(repeating: "  ", count: depth) + parts.joined(separator: " "))
            if let children = copy(element, kAXChildrenAttribute) as? [AXUIElement] {
                for child in children { walk(child, depth + 1) }
            }
        }
        walk(root, 0)
        if count >= maxNodes { lines.append("… truncated at \(maxNodes) nodes") }
        return lines.joined(separator: "\n")
    }
}
