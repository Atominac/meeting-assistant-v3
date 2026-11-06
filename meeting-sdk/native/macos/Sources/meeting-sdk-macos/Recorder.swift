import Foundation
import AVFoundation
import ScreenCaptureKit
import CoreMedia

struct RecordingError: Error, CustomStringConvertible {
    let description: String
    init(_ d: String) { description = d }
}

/// Records one meeting window (or the whole desktop's audio) to an MP4 with ScreenCaptureKit.
/// Tracks: video (the meeting window), meeting audio, microphone. The reference SDK mixes the two audio sources
/// into one track; here they are written as separate tracks (mixing is a later step).
final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
    let windowId: String
    let windowJSON: [String: Any]
    let pid: pid_t?                 // nil = whole desktop (audio only)
    /// Titles that identify the meeting's window among the app's windows, best match first.
    let titleHints: [String]
    let outputURL: URL
    private var stream: SCStream?
    private var writer: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    private var systemAudioInput: AVAssetWriterInput?
    private var micInput: AVAssetWriterInput?
    private var sessionStarted = false
    private var paused = false
    private let sampleQueue = DispatchQueue(label: "meeting-sdk.recorder.samples")
    private var capturedVideo = false, capturedAudio = false
    var onError: ((String) -> Void)?

    init(windowId: String, windowJSON: [String: Any], pid: pid_t?, titleHints: [String] = []) {
        self.windowId = windowId; self.windowJSON = windowJSON; self.pid = pid; self.titleHints = titleHints
        outputURL = FileManager.default.temporaryDirectory.appendingPathComponent("meeting-sdk-\(windowId).mp4")
    }

    var audioOnly: Bool { pid == nil }

    func start() async throws {
        guard CGPreflightScreenCaptureAccess() else {
            throw RecordingError("screen-capture permission is not granted")
        }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        let filter: SCContentFilter
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.sampleRate = 48000
        config.channelCount = 2
        if #available(macOS 15.0, *) { config.captureMicrophone = true }

        var size = CGSize(width: 2, height: 2)
        if let pid {
            // Only windows that are really on a display can be captured; ScreenCaptureKit aborts the process otherwise.
            let onDisplay = content.windows.filter { w in
                w.owningApplication?.processID == pid && w.isOnScreen && w.frame.width > 200 && w.frame.height > 150
                    && content.displays.contains { $0.frame.intersects(w.frame) }
            }
            // The meeting's window by title; failing that, the biggest candidate.
            var chosen: SCWindow?
            for hint in titleHints where !hint.isEmpty && chosen == nil {
                chosen = onDisplay.first { ($0.title ?? "") == hint } ?? onDisplay.first { ($0.title ?? "").contains(hint) }
            }
            chosen = chosen ?? onDisplay.max { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }
            guard let window = chosen else {
                throw RecordingError("the meeting window is not visible on any display (minimized or on another Space?)")
            }
            filter = SCContentFilter(desktopIndependentWindow: window)
            size = CGSize(width: min(window.frame.width * 2, 3840), height: min(window.frame.height * 2, 2160))
            config.minimumFrameInterval = CMTime(value: 1, timescale: 15)
        } else {
            guard let display = content.displays.first else { throw RecordingError("no display found") }
            filter = SCContentFilter(display: display, excludingWindows: [])
            config.minimumFrameInterval = CMTime(value: 1, timescale: 1)   // video is unused for desktop audio
        }
        config.width = Int(size.width) & ~1
        config.height = Int(size.height) & ~1
        config.queueDepth = 6

        let w = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)
        if !audioOnly {
            let v = AVAssetWriterInput(mediaType: .video, outputSettings: [
                AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: config.width, AVVideoHeightKey: config.height,
                AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 2_500_000, AVVideoExpectedSourceFrameRateKey: 15],
            ])
            v.expectsMediaDataInRealTime = true
            w.add(v); videoInput = v
        }
        func audioInput(channels: Int) -> AVAssetWriterInput {
            let a = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48000, AVNumberOfChannelsKey: channels, AVEncoderBitRateKey: 96_000,
            ])
            a.expectsMediaDataInRealTime = true
            w.add(a)
            return a
        }
        systemAudioInput = audioInput(channels: 2)
        micInput = audioInput(channels: 1)
        guard w.startWriting() else { throw RecordingError("cannot write \(outputURL.path): \(w.error?.localizedDescription ?? "unknown")") }
        writer = w

        let s = SCStream(filter: filter, configuration: config, delegate: self)
        try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
        try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: sampleQueue)
        if #available(macOS 15.0, *) { try s.addStreamOutput(self, type: .microphone, sampleHandlerQueue: sampleQueue) }
        stream = s
        try await s.startCapture()
    }

    func pause() { sampleQueue.async { self.paused = true } }
    func resume() { sampleQueue.async { self.paused = false } }

    /// Stops capture and finishes the file. Returns the file URL.
    func stop() async -> URL? {
        try? await stream?.stopCapture()
        stream = nil
        return await withCheckedContinuation { cont in
            sampleQueue.async {
                guard let w = self.writer, self.sessionStarted else { self.writer?.cancelWriting(); cont.resume(returning: nil); return }
                self.videoInput?.markAsFinished(); self.systemAudioInput?.markAsFinished(); self.micInput?.markAsFinished()
                w.finishWriting { cont.resume(returning: w.status == .completed ? self.outputURL : nil) }
            }
        }
    }

    // MARK: SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard buffer.isValid, !paused, let writer, writer.status == .writing else { return }

        if type == .screen {
            // Only complete frames carry pixels; idle/blank updates have no image buffer.
            guard let attachments = CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
                  let raw = attachments.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete else { return }
        }
        // The file's timeline starts at the first frame (or first audio sample for audio-only recordings).
        if !sessionStarted {
            guard type == .screen || audioOnly else { return }
            writer.startSession(atSourceTime: buffer.presentationTimeStamp)
            sessionStarted = true
        }
        switch type {
        case .screen:
            if videoInput?.isReadyForMoreMediaData == true, videoInput?.append(buffer) == true, !capturedVideo {
                capturedVideo = true; onCapture?("video")
            }
        case .audio:
            if systemAudioInput?.isReadyForMoreMediaData == true, systemAudioInput?.append(buffer) == true, !capturedAudio {
                capturedAudio = true; onCapture?("audio")
            }
        default:
            if micInput?.isReadyForMoreMediaData == true { micInput?.append(buffer) }
        }
    }

    var onCapture: ((String) -> Void)?

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        onError?("capture stopped: \(error.localizedDescription)")
    }
}

/// Uploads a finished recording to the server (the mock server in development).
enum Uploader {
    static func upload(file: URL, apiUrl: String, token: String) async throws {
        guard let url = URL(string: "\(apiUrl)/upload/\(token)/media") else { throw RecordingError("bad api url") }
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue("video/mp4", forHTTPHeaderField: "content-type")
        let (_, response) = try await URLSession.shared.upload(for: request, fromFile: file)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw RecordingError("upload failed: HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)")
        }
    }

    /// Sends one participant event. The JSON content type matters: the server ignores bodies without it.
    static func postEvent(apiUrl: String, token: String, body: [String: Any], done: ((Int?) -> Void)? = nil) {
        guard let url = URL(string: "\(apiUrl)/upload/\(token)/events"),
              let data = try? JSONSerialization.data(withJSONObject: body) else { done?(nil); return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = data
        URLSession.shared.dataTask(with: request) { _, response, error in
            let status = (response as? HTTPURLResponse)?.statusCode
            if ProcessInfo.processInfo.environment["MSDK_DEBUG"] != nil, error != nil || status != 200 {
                Wire.log("event upload failed: \(error?.localizedDescription ?? "HTTP \(status ?? 0)")")
            }
            done?(status)
        }.resume()
    }
}
