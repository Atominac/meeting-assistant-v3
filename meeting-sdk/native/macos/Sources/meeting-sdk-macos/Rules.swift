import Foundation

/// Detection rules. Pure functions of an accessibility tree, so they run the same on live apps and on recorded
/// fixtures. Selectors marked UNVERIFIED are best readings of the reference SDK's strings and have not yet been
/// checked against a live call (see docs/PLAN.md, Phase 1).
enum Platform: String {
    case zoom = "zoom"
    case googleMeet = "google-meet"
    case teams = "teams"
}

struct Observation {
    var platform: Platform
    /// Stable per meeting, used to keep the same window id across polls.
    var key: String
    var title: String?
    var url: String?
    var bundleId: String
    var live: Bool
    /// The "you left the meeting" screen: the meeting is over, close it without waiting.
    var afterCall: Bool
    /// The subtree to read participants from: the meeting's window, or the whole app for Zoom.
    var scope: AXNode? = nil
    /// The meeting window's own title, used to find the same window when recording.
    var windowTitle: String? = nil
}

enum Rules {
    static let zoomBundle = "us.zoom.xos"
    static let teamsBundles: Set<String> = ["com.microsoft.teams2", "com.microsoft.teams"]
    static let chromiumBundles: Set<String> = [
        "com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.canary", "com.google.Chrome.dev",
        "com.google.chrome.for.testing", "com.brave.Browser", "com.brave.Browser.beta", "com.brave.Browser.nightly",
        "com.microsoft.edgemac", "com.microsoft.edgemac.Beta", "com.microsoft.edgemac.Canary", "com.microsoft.edgemac.Dev",
        "company.thebrowser.Browser", "company.thebrowser.dia", "org.chromium.Chromium",
    ]
    static let safariBundle = "com.apple.Safari"
    static var watchedBundles: Set<String> { chromiumBundles.union(teamsBundles).union([zoomBundle, safariBundle]) }

    private static let meetURL = try! NSRegularExpression(pattern: "^https://meet\\.google\\.com/(?:meet/)?([a-z]{3}-[a-z]{4}-[a-z]{3})(?:[/?#].*)?$")
    private static let zoomWebURL = try! NSRegularExpression(pattern: "^https://((?:[A-Za-z0-9-]+\\.)*zoom\\.us)/wc/(\\d+)(?:[/?#].*)?$")
    private static let teamsWebURL = try! NSRegularExpression(pattern: "^https://teams\\.(?:microsoft|live)\\.com/v2/.*$")

    private static func match(_ re: NSRegularExpression, _ s: String) -> [String]? {
        let range = NSRange(s.startIndex..., in: s)
        guard let m = re.firstMatch(in: s, range: range) else { return nil }
        return (0..<m.numberOfRanges).map { i in Range(m.range(at: i), in: s).map { String(s[$0]) } ?? "" }
    }

    private static func has(_ s: String, _ pattern: String) -> Bool {
        s.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
    }

    private static func isButton(_ n: AXNode) -> Bool { n.role == "AXButton" || n.role == "AXMenuButton" }

    /// Window title without the browser's suffix, e.g. "Standup - Google Chrome" -> "Standup".
    private static func cleanTitle(_ t: String?) -> String? {
        guard var t, !t.isEmpty else { return nil }
        // "Standup - Google Chrome – Alok" (browser name, then the profile name) -> "Standup"
        if let r = t.range(of: " - (Google Chrome|Brave|Microsoft Edge|Chromium|Safari|Arc|Dia)( – .*)?$", options: .regularExpression) {
            t = String(t[..<r.lowerBound])
        }
        return t.isEmpty ? nil : t
    }

    static func observe(bundleId: String, app: AXNode) -> [Observation] {
        if bundleId == zoomBundle { return observeZoomApp(bundleId, app) }
        if teamsBundles.contains(bundleId) { return observeTeamsApp(bundleId, app) }
        if chromiumBundles.contains(bundleId) || bundleId == safariBundle { return observeBrowser(bundleId, app) }
        return []
    }

    // Zoom desktop. UNVERIFIED: window "Zoom Meeting" and a "Meeting" menu-bar item are both strings in the
    // reference SDK; Zoom shows the menu only while in a meeting.
    private static func observeZoomApp(_ bundle: String, _ app: AXNode) -> [Observation] {
        let windows = app.children.filter { $0.role == "AXWindow" }
        let inMeetingWindow = windows.first { ($0.title ?? "") == "Zoom Meeting" }
        let meetingMenu = app.children.first { $0.role == "AXMenuBar" }?.children
            .contains { $0.role == "AXMenuBarItem" && ($0.title ?? "") == "Meeting" } ?? false
        guard inMeetingWindow != nil || meetingMenu else { return [] }
        let topic = windows.compactMap(\.title).first { !$0.isEmpty && $0 != "Zoom Meeting" && !$0.hasPrefix("zoom share") && $0 != "Zoom Workplace" }
        return [Observation(platform: .zoom, key: "zoom-app", title: topic, url: nil, bundleId: bundle, live: true, afterCall: false, scope: app, windowTitle: inMeetingWindow?.title)]
    }

    // Teams desktop. UNVERIFIED: live call = a Leave / Hang up button in a window.
    private static func observeTeamsApp(_ bundle: String, _ app: AXNode) -> [Observation] {
        for window in app.children where window.role == "AXWindow" {
            let leave = window.contains { isButton($0) && has($0.label, "\\b(leave|hang up)\\b") }
            if leave {
                return [Observation(platform: .teams, key: "teams-app", title: window.title, url: nil, bundleId: bundle, live: true, afterCall: false, scope: window, windowTitle: window.title)]
            }
        }
        return []
    }

    // Meet, Zoom web and Teams web in a Chromium browser or Safari: the page URL says which platform it is, and
    // the call controls say whether it is a live call. Meet's URL regex and Zoom web's regex are from the reference SDK.
    private static func observeBrowser(_ bundle: String, _ app: AXNode) -> [Observation] {
        var out: [Observation] = []
        for window in app.children where window.role == "AXWindow" {
            let web = window.first { $0.role == "AXWebArea" && ($0.url ?? "").hasPrefix("http") }
            let url = web?.url ?? window.first { ($0.url ?? "").hasPrefix("http") }?.url
            guard let url else { continue }
            let area = web ?? window
            let leaveButton = area.contains { isButton($0) && has($0.label, "\\bleave call\\b") }

            if let m = match(meetURL, url) {
                let afterCall = !leaveButton && area.contains { has($0.label, "(you left the meeting|return to home screen|rejoin)") }
                out.append(Observation(platform: .googleMeet, key: "google-meet:\(m[1])", title: cleanTitle(web?.title ?? window.title),
                                       url: "https://meet.google.com/\(m[1])", bundleId: bundle, live: leaveButton, afterCall: afterCall, scope: window, windowTitle: window.title))
            } else if let m = match(zoomWebURL, url) {
                let live = area.contains { isButton($0) && has($0.label, "^(leave|end)\\b") }
                out.append(Observation(platform: .zoom, key: "zoom-web:\(m[2])", title: cleanTitle(window.title), url: url, bundleId: bundle, live: live, afterCall: false, scope: window, windowTitle: window.title))
            } else if match(teamsWebURL, url) != nil {
                let live = area.contains { isButton($0) && has($0.label, "\\b(leave|hang up)\\b") }
                out.append(Observation(platform: .teams, key: "teams-web:\(window.title ?? url)", title: cleanTitle(window.title), url: url, bundleId: bundle, live: live, afterCall: false, scope: window, windowTitle: window.title))
            }
        }
        return out
    }
}
