import Foundation

struct ParticipantObs: Equatable {
    var name: String
    var isHost: Bool
    var speaking: Bool
}

/// Participant scraping from the accessibility tree. UNVERIFIED against live calls: it reads the participants
/// list panel (a list or table labelled Participants / People) and takes each row's first text as the name.
/// People who are not drawn on screen cannot be seen, which is also true of the reference SDK's screen-reading mode.
enum ParticipantRules {
    private static func has(_ s: String, _ pattern: String) -> Bool {
        s.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
    }

    static let listRoles: Set<String> = ["AXList", "AXTable", "AXOutline", "AXGroup", "AXScrollArea"]
    static let rowRoles: Set<String> = ["AXRow", "AXCell", "AXGroup", "AXListItem", "AXStaticText"]

    /// "Ana Ruiz (Host)", "Ana Ruiz (You)", "Ana Ruiz, Host" -> "Ana Ruiz".
    static func cleanName(_ raw: String) -> (name: String, host: Bool) {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        var host = false
        let tags = ["(Host)", "(host)", "(Co-host)", "(co-host)", "(Me)", "(me)", "(You)", "(you)", "(Guest)", "(guest)", "(Presenter)", "(Organizer)"]
        for t in tags where s.contains(t) {
            if t.lowercased().contains("host") || t.contains("Organizer") { host = true }
            s = s.replacingOccurrences(of: t, with: "")
        }
        if let r = s.range(of: ", host", options: [.caseInsensitive, .backwards]) { host = true; s = String(s[..<r.lowerBound]) }
        return (s.trimmingCharacters(in: .whitespacesAndNewlines), host)
    }

    // Text on a video tile that is not a person's name.
    private static let notAName = "(microphone|camera|presenting|presentation|pinned|muted|reducing noise|joined|left the|waiting|caption|"
        + "turned (on|off)|raise|hand|screen|meeting|call|chat|people|activities|more options|^you$|^\\d{1,2}:\\d{2}|^[a-z]{3}-[a-z]{4}-[a-z]{3}$|[.!?]$)"

    /// Meet class names for a tile that is speaking, taken from the reference SDK's Meet scraper ("active speaker
    /// indicator" and "active speaker container"). Absent from the tree while the tile is silent, present while speaking.
    static let meetSpeakingClasses: Set<String> = ["fdKMD", "kssMZb"]
    /// Class of the muted-microphone icon on a tile (the reference SDK's "is muted"); not used for events yet.
    static let meetMutedClass = "FTMc0c"

    private static func hasClass(_ n: AXNode, in classes: Set<String>) -> Bool {
        guard let list = n.domClass else { return false }
        return list.split(separator: " ").contains { classes.contains(String($0)) }
    }

    /// Names drawn on the video tiles, for when the People panel is closed. Read from Meet's main region (the tile grid),
    /// outside any button. Meet calls the local user's own tile "You"; that is kept so the server can put the real name in.
    /// A tile is the part of the tree around one name that holds no other name; it is speaking when it contains a
    /// speaking class (above).
    /// One video tile: the person's name and the part of the tree that belongs to it.
    struct Tile { var name: String; var host: Bool; var root: AXNode }

    static func tileList(_ scope: AXNode) -> [Tile] {
        guard let main = scope.first(where: { $0.subrole == "AXLandmarkMain" }) else { return [] }
        struct Candidate { var name: String; var host: Bool; var root: AXNode? }

        func gather(_ n: AXNode) -> [Candidate] {
            if n.role == "AXButton" || n.role == "AXPopUpButton" || n.role == "AXMenu" { return [] }
            if n.role == "AXStaticText", let raw = n.value ?? n.title {
                let (name, host) = cleanName(raw)
                let isSelf = name.caseInsensitiveCompare("you") == .orderedSame
                if isSelf || (!name.isEmpty && name.count <= 60 && !has(name, notAName)) {
                    return [Candidate(name: isSelf ? "You" : name, host: host, root: nil)]
                }
                return []
            }
            var results = n.children.map(gather)
            let withNames = results.indices.filter { !results[$0].isEmpty }
            if withNames.count >= 2 {   // several names meet here: each child below is one tile
                for i in withNames {
                    for j in results[i].indices where results[i][j].root == nil { results[i][j].root = n.children[i] }
                }
            }
            return results.flatMap { $0 }
        }

        var seen = Set<String>(), out: [Tile] = []
        for c in gather(main) where seen.insert(c.name).inserted {
            out.append(Tile(name: c.name, host: c.host, root: c.root ?? main))
        }
        return out
    }

    /// Every CSS class on a tile (and below it). Used by tools/speaking-probe.mjs to find which ones switch with speech.
    static func classes(in tile: AXNode) -> [String] {
        var set = Set<String>()
        for n in tile.descendants(where: { $0.domClass != nil }) { n.domClass!.split(separator: " ").forEach { set.insert(String($0)) } }
        return set.sorted()
    }

    static func tiles(_ scope: AXNode) -> [ParticipantObs] {
        tileList(scope).map { t in
            ParticipantObs(name: t.name, isHost: t.host, speaking: t.root.contains { hasClass($0, in: meetSpeakingClasses) })
        }
    }

    static func scrape(_ scope: AXNode) -> [ParticipantObs] {
        let fromPanel = panel(scope)
        return fromPanel.isEmpty ? tiles(scope) : fromPanel
    }

    static func panel(_ scope: AXNode) -> [ParticipantObs] {
        // Panel container: something labelled Participants / People that has rows below it.
        let containers = scope.descendants { n in
            listRoles.contains(n.role) && has(n.label, "^(participants|people|in this meeting|attendees)\\b") && !n.children.isEmpty
        }
        guard let container = containers.max(by: { $0.descendants { _ in true }.count < $1.descendants { _ in true }.count }) else { return [] }

        // Rows: direct list items if the container has them, otherwise its immediate children.
        var rows = container.descendants { $0.role == "AXRow" || $0.subrole == "AXListItem" }
        if rows.isEmpty { rows = container.children.filter { rowRoles.contains($0.role) && !$0.children.isEmpty } }

        var seen = Set<String>(), out: [ParticipantObs] = []
        for row in rows {
            guard let nameText = row.first(where: { $0.role == "AXStaticText" && !($0.value ?? $0.title ?? "").isEmpty }),
                  let raw = nameText.value ?? nameText.title else { continue }
            let (name, tagHost) = cleanName(raw)
            if name.isEmpty || has(name, "^(participants|people|mute all|invite|share|search)\\b") { continue }
            let all = row.descendants { _ in true }.map(\.label).joined(separator: " ")
            let host = tagHost || has(all, "\\b(host|organizer)\\b")
            let speaking = has(all, "\\b(is speaking|active speaker|speaking)\\b") && !has(all, "not speaking")
            if seen.insert(name).inserted { out.append(ParticipantObs(name: name, isHost: host, speaking: speaking)) }
        }
        return out
    }
}

/// Diffs successive scrapes into participant events with timestamps.
final class ParticipantTracker {
    struct Known { var id: Int; var obs: ParticipantObs; var lastSpoke: Date? = nil }
    private var known: [String: Known] = [:]
    private var nextId = 1
    private var missing: [String: Int] = [:]
    /// A name must be missing this many polls in a row before it counts as left, so a flicker is not a leave.
    let missThreshold: Int
    let startedAt: Date

    /// Meet shows the speaking mark only while there is sound, and it flickers between words. Speech is kept "on" this
    /// long after the mark was last seen, so a pause between words does not become a stop and a start.
    let speechHold: TimeInterval

    init(missThreshold: Int = 3, startedAt: Date = Date(), speechHold: TimeInterval = 0) {
        self.missThreshold = missThreshold; self.startedAt = startedAt; self.speechHold = speechHold
    }

    struct Change { var event: String; var id: Int; var obs: ParticipantObs; var at: Date }

    func update(_ now: [ParticipantObs], at: Date = Date()) -> [Change] {
        var changes: [Change] = []
        var present = Set<String>()
        for var obs in now {
            present.insert(obs.name)
            missing[obs.name] = 0
            if obs.speaking { known[obs.name]?.lastSpoke = at }
            else if let last = known[obs.name]?.lastSpoke, at.timeIntervalSince(last) < speechHold { obs.speaking = true }
            if let old = known[obs.name] {
                if old.obs.isHost != obs.isHost { changes.append(Change(event: "update", id: old.id, obs: obs, at: at)) }
                if old.obs.speaking != obs.speaking { changes.append(Change(event: obs.speaking ? "speech_on" : "speech_off", id: old.id, obs: obs, at: at)) }
                known[obs.name] = Known(id: old.id, obs: obs, lastSpoke: known[obs.name]?.lastSpoke)
            } else {
                let id = nextId; nextId += 1
                known[obs.name] = Known(id: id, obs: obs, lastSpoke: obs.speaking ? at : nil)
                changes.append(Change(event: "join", id: id, obs: obs, at: at))
                if obs.speaking { changes.append(Change(event: "speech_on", id: id, obs: obs, at: at)) }
            }
        }
        for (name, k) in known where !present.contains(name) {
            missing[name, default: 0] += 1
            if missing[name]! >= missThreshold {
                if k.obs.speaking { changes.append(Change(event: "speech_off", id: k.id, obs: k.obs, at: at)) }
                changes.append(Change(event: "leave", id: k.id, obs: k.obs, at: at))
                known[name] = nil; missing[name] = nil
            }
        }
        return changes
    }
}
