import Foundation
import AppKit
import ApplicationServices

/// A plain copy of one accessibility element and its children. Detection rules work on this type, not on live
/// AXUIElements, so they can be tested with recorded trees.
struct AXNode: Codable {
    var role: String
    var subrole: String?
    var title: String?
    var desc: String?
    var value: String?
    var id: String?
    var domClass: String?
    var url: String?
    var children: [AXNode]

    init(role: String, subrole: String? = nil, title: String? = nil, desc: String? = nil, value: String? = nil,
         id: String? = nil, domClass: String? = nil, url: String? = nil, children: [AXNode] = []) {
        self.role = role; self.subrole = subrole; self.title = title; self.desc = desc; self.value = value
        self.id = id; self.domClass = domClass; self.url = url; self.children = children
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        role = try c.decodeIfPresent(String.self, forKey: .role) ?? "?"
        subrole = try c.decodeIfPresent(String.self, forKey: .subrole)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        desc = try c.decodeIfPresent(String.self, forKey: .desc)
        value = try c.decodeIfPresent(String.self, forKey: .value)
        id = try c.decodeIfPresent(String.self, forKey: .id)
        domClass = try c.decodeIfPresent(String.self, forKey: .domClass)
        url = try c.decodeIfPresent(String.self, forKey: .url)
        children = try c.decodeIfPresent([AXNode].self, forKey: .children) ?? []
    }

    /// All text the element carries, for matching labels.
    var label: String { [title, desc, value].compactMap { $0 }.joined(separator: " ") }

    func descendants(where predicate: (AXNode) -> Bool) -> [AXNode] {
        var out: [AXNode] = []
        func visit(_ n: AXNode) { if predicate(n) { out.append(n) }; n.children.forEach(visit) }
        visit(self)
        return out
    }

    func first(where predicate: (AXNode) -> Bool) -> AXNode? { descendants(where: predicate).first }
    func contains(where predicate: (AXNode) -> Bool) -> Bool { first(where: predicate) != nil }

    func render(depth: Int = 0) -> String {
        var parts = [role]
        if let v = subrole { parts.append("subrole=\(v)") }
        for (k, v) in [("title", title), ("desc", desc), ("value", value), ("id", id), ("domClass", domClass), ("url", url)] {
            if var v, !v.isEmpty { if v.count > 160 { v = String(v.prefix(160)) + "…" }; parts.append("\(k)=\"\(v)\"") }
        }
        return ([String(repeating: "  ", count: depth) + parts.joined(separator: " ")] + children.map { $0.render(depth: depth + 1) })
            .joined(separator: "\n")
    }
}

enum AX {
    private static func copy(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success ? value : nil
    }

    private static func text(_ value: CFTypeRef?) -> String? {
        guard let value else { return nil }
        if CFGetTypeID(value) == CFURLGetTypeID() { return (value as! CFURL as URL).absoluteString }
        if let s = value as? String { return s.isEmpty ? nil : s }
        if let n = value as? NSNumber { return n.stringValue }
        if let a = value as? [String] { return a.isEmpty ? nil : a.joined(separator: " ") }
        return nil
    }

    /// Chromium only builds its page accessibility tree after an assistive client asks for it.
    static func enableChromiumAccessibility(pid: pid_t) {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
        AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    }

    /// With `windowContaining`, only the app's windows whose title contains that text are read (much faster for a browser
    /// with many windows). If none match, the whole app is read, so a renamed window cannot hide the meeting.
    static func snapshot(pid: pid_t, windowContaining: String? = nil, maxDepth: Int = 30, maxNodes: Int = 8000) -> AXNode {
        let full = snapshotOnce(pid: pid, windowContaining: windowContaining, maxDepth: maxDepth, maxNodes: maxNodes)
        if windowContaining != nil, !full.children.contains(where: { $0.role == "AXWindow" }) {
            return snapshotOnce(pid: pid, windowContaining: nil, maxDepth: maxDepth, maxNodes: maxNodes)
        }
        return full
    }

    private static func snapshotOnce(pid: pid_t, windowContaining: String?, maxDepth: Int, maxNodes: Int) -> AXNode {
        var count = 0
        func build(_ element: AXUIElement, _ depth: Int) -> AXNode {
            count += 1
            var node = AXNode(
                role: text(copy(element, kAXRoleAttribute)) ?? "?",
                subrole: text(copy(element, kAXSubroleAttribute)),
                title: text(copy(element, kAXTitleAttribute)),
                desc: text(copy(element, kAXDescriptionAttribute)),
                value: text(copy(element, kAXValueAttribute)),
                id: text(copy(element, "AXIdentifier")),
                domClass: text(copy(element, "AXDOMClassList")),
                url: text(copy(element, kAXURLAttribute)))
            if depth < maxDepth, count < maxNodes, let kids = copy(element, kAXChildrenAttribute) as? [AXUIElement] {
                for kid in kids where count < maxNodes {
                    if depth == 0, let want = windowContaining, text(copy(kid, kAXRoleAttribute)) == "AXWindow",
                       !(text(copy(kid, kAXTitleAttribute)) ?? "").contains(want) { continue }
                    node.children.append(build(kid, depth + 1))
                }
            }
            return node
        }
        return build(AXUIElementCreateApplication(pid), 0)
    }
}
