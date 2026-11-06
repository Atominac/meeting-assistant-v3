import Foundation
import AppKit
import ApplicationServices
import AVFoundation
import CoreGraphics

/// Permission names match the `Permission` type in the SDK contract.
enum Permissions {
    static let startupAllowed = ["accessibility", "screen-capture", "microphone", "system-audio", "full-disk-access"]
    /// The reference SDK reports every permission once during init, in this order, before the init response.
    static let all = ["accessibility", "microphone", "screen-capture", "system-audio", "full-disk-access",
                      "teams-automation", "browser-automation", "zoom-raw-media"]

    static func status(_ permission: String) -> (status: String, error: String?) {
        switch permission {
        case "accessibility":
            return (AXIsProcessTrusted() ? "granted" : "not_requested", nil)
        case "screen-capture":
            return (CGPreflightScreenCaptureAccess() ? "granted" : "not_requested", nil)
        case "microphone":
            switch AVCaptureDevice.authorizationStatus(for: .audio) {
            case .authorized: return ("granted", nil)
            case .notDetermined: return ("not_requested", nil)
            default: return ("denied", nil)
            }
        case "teams-automation":
            let installed = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.microsoft.teams2") != nil
                || NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.microsoft.teams") != nil
            return (installed ? "not_requested" : "not_installed", nil)
        case "system-audio", "full-disk-access", "browser-automation", "zoom-raw-media":
            // The checks for these are not written yet. "not_requested" matches the reference SDK's
            // answer when nothing has asked for them; it is never reported as granted.
            return ("not_requested", nil)
        default:
            return ("error", "unknown permission")
        }
    }

    static func emitStatus(_ permission: String) {
        let s = status(permission)
        var payload: [String: Any] = ["permission": permission, "granted": s.status == "granted", "status": s.status]
        if let e = s.error { payload["error"] = e }
        Wire.emit("permission-status", payload)
    }

    static func request(_ permission: String, done: @escaping () -> Void) {
        switch permission {
        case "accessibility":
            let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
            _ = AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
            done()
        case "screen-capture":
            _ = CGRequestScreenCaptureAccess()
            done()
        case "microphone":
            AVCaptureDevice.requestAccess(for: .audio) { _ in done() }
        default:
            done()
        }
    }
}
