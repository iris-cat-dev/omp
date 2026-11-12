import AppKit
import ApplicationServices
import Foundation
import ImageIO
import Vision

// Launch the real bundle without --app, injected code, or dialog overrides.
// The software-rendered modal has no AX tree; locate its controls in screenshots.
struct SmokeFailure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

func elements(_ element: AXUIElement, _ name: String) -> [AXUIElement] {
    attribute(element, name) as? [AXUIElement] ?? []
}

func mainWindow(_ application: AXUIElement) -> AXUIElement? {
    elements(application, kAXWindowsAttribute).first {
        attribute($0, kAXSubroleAttribute) as? String == kAXStandardWindowSubrole
    }
}

func findElement(_ root: AXUIElement, title: String, subrole: String) -> AXUIElement? {
    if attribute(root, kAXTitleAttribute) as? String == title,
       attribute(root, kAXSubroleAttribute) as? String == subrole { return root }
    for child in elements(root, kAXChildrenAttribute) {
        if let found = findElement(child, title: title, subrole: subrole) { return found }
    }
    return nil
}

func bounds(_ element: AXUIElement) throws -> CGRect {
    guard let position = attribute(element, kAXPositionAttribute),
          let size = attribute(element, kAXSizeAttribute) else {
        throw SmokeFailure("Native element has no screen bounds: role=\(attribute(element, kAXRoleAttribute) as? String ?? "nil"), subrole=\(attribute(element, kAXSubroleAttribute) as? String ?? "nil")")
    }
    var origin = CGPoint.zero
    var dimensions = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &origin),
          AXValueGetValue(size as! AXValue, .cgSize, &dimensions) else {
        throw SmokeFailure("Cannot read native element screen bounds")
    }
    return CGRect(origin: origin, size: dimensions)
}

func click(_ point: CGPoint) throws {
    for type in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseUp] {
        guard let event = CGEvent(mouseEventSource: nil, mouseType: type,
                                  mouseCursorPosition: point, mouseButton: .left) else {
            throw SmokeFailure("Cannot create system mouse event")
        }
        event.post(tap: .cghidEventTap)
        // Mouse-up arrives in a later native pump turn, as with a real mouse.
        Thread.sleep(forTimeInterval: 0.1)
    }
}

func click(_ element: AXUIElement) throws {
    let rectangle = try bounds(element)
    try click(CGPoint(x: rectangle.midX, y: rectangle.midY))
}

func waitFor(_ message: String, timeout: TimeInterval = 20, _ condition: () -> Bool) throws {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition() {
        if Date() >= deadline { throw SmokeFailure(message) }
        Thread.sleep(forTimeInterval: 0.1)
    }
}

struct RenderedControls {
    let application: AXUIElement
    let screenshot: URL

    func locate(_ label: String) throws -> CGPoint? {
        guard let window = mainWindow(application), let frame = try? bounds(window) else { return nil }
        let capture = Process()
        capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        capture.arguments = ["-x", "-R\(Int(frame.minX)),\(Int(frame.minY)),\(Int(frame.width)),\(Int(frame.height))", screenshot.path]
        try capture.run()
        capture.waitUntilExit()
        guard capture.terminationStatus == 0,
              let source = CGImageSourceCreateWithURL(screenshot as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            throw SmokeFailure("Cannot capture the packaged window")
        }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["zh-Hans", "en-US"]
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image).perform([request])
        for observation in request.results ?? [] {
            guard let candidate = observation.topCandidates(1).first,
                  let range = candidate.string.range(of: label),
                  let rectangle = try candidate.boundingBox(for: range)?.boundingBox else { continue }
            return CGPoint(x: frame.minX + rectangle.midX * frame.width,
                           y: frame.minY + (1 - rectangle.midY) * frame.height)
        }
        return nil
    }

    func waitFor(_ label: String) throws -> CGPoint {
        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline {
            if let point = try locate(label) { return point }
            Thread.sleep(forTimeInterval: 0.2)
        }
        throw SmokeFailure("Original application modal control did not appear: \(label)")
    }
}

func run() throws {
    guard CommandLine.arguments.count == 2 else {
        throw SmokeFailure("Usage: swift macos-window-close-smoke.swift '/path/to/OMP Desktop.app'")
    }
    guard AXIsProcessTrusted(), CGPreflightPostEventAccess(), CGPreflightScreenCaptureAccess() else {
        throw SmokeFailure("Accessibility, screen capture, and system mouse-event permission are required")
    }
    let session = CGSessionCopyCurrentDictionary() as? [String: Any]
    guard session?["CGSSessionScreenIsLocked"] as? Bool != true else {
        throw SmokeFailure("Unlock macOS before running system mouse verification")
    }
    let bundle = URL(fileURLWithPath: CommandLine.arguments[1])
    let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("omp-native-close-\(UUID().uuidString)")
    let userData = temporary.appendingPathComponent("user-data")
    let home = temporary.appendingPathComponent("home")
    try FileManager.default.createDirectory(at: userData, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: temporary) }
    let listen = "127.0.0.1:0"
    let settings: [String: Any] = [
        "version": 1,
        "settings": [
            "releaseChannel": "stable", "browser": ["target": "system"],
            "notifications": ["playSound": false],
            "daemon": ["manageBuiltInDaemon": true, "keepRunningAfterQuit": false],
            "window": ["closeBehavior": "ask"],
            "pet": ["enabled": false, "size": "medium", "selectedId": "iris", "position": NSNull()]
        ],
        "migrations": ["legacyRendererSettingsImported": false, "daemonStopOnQuitDefaultApplied": true]
    ]
    try JSONSerialization.data(withJSONObject: settings).write(to: userData.appendingPathComponent("desktop-settings.json"))
    try JSONSerialization.data(withJSONObject: ["version": 1, "daemon": ["listen": listen, "relay": ["enabled": false], "mcp": ["enabled": false, "injectIntoAgents": false]]]).write(to: home.appendingPathComponent("config.json"))
    let log = temporary.appendingPathComponent("application.log")
    FileManager.default.createFile(atPath: log.path, contents: nil)
    let output = try FileHandle(forWritingTo: log)
    defer { try? output.close() }
    let process = Process()
    process.executableURL = bundle.appendingPathComponent("Contents/MacOS/OMP Desktop")
    process.environment = ProcessInfo.processInfo.environment.merging([
        "PASEO_HOME": home.path, "PASEO_LISTEN": listen,
        "OMP_ELECTRON_USER_DATA_DIR": userData.path
    ]) { _, value in value }
    process.environment?.removeValue(forKey: "ELECTRON_RUN_AS_NODE")
    process.environment?.removeValue(forKey: "DYLD_INSERT_LIBRARIES")
    process.standardOutput = output
    process.standardError = output
    try process.run()
    defer {
        if process.isRunning {
            process.terminate()
            let deadline = Date().addingTimeInterval(10)
            while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.1) }
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
            process.waitUntilExit()
        }
    }
    do {
        let application = AXUIElementCreateApplication(process.processIdentifier)
        try waitFor("Packaged main window did not appear") { !elements(application, kAXWindowsAttribute).isEmpty }
        let window = elements(application, kAXWindowsAttribute)[0]
        let pidFile = home.appendingPathComponent("omp-desktop.pid")
        var daemonPID: pid_t = 0
        try waitFor("Renderer did not start the built-in daemon", timeout: 45) {
            guard let data = try? Data(contentsOf: pidFile),
                  let document = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let pid = document["pid"] as? Int, pid > 0 else { return false }
            daemonPID = pid_t(pid)
            return kill(daemonPID, 0) == 0
        }
        func windowButton(_ name: String) throws -> AXUIElement {
            var result: AXUIElement?
            try waitFor("Native window button did not become available: \(name)") {
                guard let current = mainWindow(application), let value = attribute(current, name) else { return false }
                let button = value as! AXUIElement
                guard attribute(button, kAXRoleAttribute) as? String == kAXButtonRole,
                      let frame = try? bounds(button), frame.width > 0, frame.height > 0 else { return false }
                result = button
                return true
            }
            return result!
        }
        NSRunningApplication(processIdentifier: process.processIdentifier)?.activate(options: [])
        let closeFrame = try bounds(windowButton(kAXCloseButtonAttribute))
        let minimizeFrame = try bounds(windowButton(kAXMinimizeButtonAttribute))
        let zoomFrame = try bounds(windowButton(kAXZoomButtonAttribute))
        guard abs((minimizeFrame.midX - closeFrame.midX) - (zoomFrame.midX - minimizeFrame.midX)) < 0.1 else {
            throw SmokeFailure("Native traffic-light spacing is unequal")
        }
        let originalFrame = try bounds(window)
        try click(windowButton(kAXMinimizeButtonAttribute))
        try waitFor("Yellow button did not minimize the window") { attribute(window, kAXMinimizedAttribute) as? Bool == true }
        guard let dock = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock").first else { throw SmokeFailure("Dock is not running") }
        let dockApplication = AXUIElementCreateApplication(dock.processIdentifier)
        guard let appTile = findElement(dockApplication, title: "OMP Desktop", subrole: "AXApplicationDockItem") else { throw SmokeFailure("OMP Desktop Dock icon missing") }
        try click(appTile)
        try waitFor("Dock click did not restore the minimized window") { attribute(window, kAXMinimizedAttribute) as? Bool == false }
        print("PASS: yellow minimize button → Dock restore")
        try click(windowButton(kAXZoomButtonAttribute))
        try waitFor("Green button did not enlarge the actual window") {
            guard let frame = try? bounds(window) else { return false }
            return frame.width > originalFrame.width + 1 || frame.height > originalFrame.height + 1
        }
        try click(windowButton(kAXZoomButtonAttribute))
        try waitFor("Green button did not restore the original window dimensions") {
            guard let frame = try? bounds(window) else { return false }
            return abs(frame.width - originalFrame.width) < 1 && abs(frame.height - originalFrame.height) < 1
        }
        print("PASS: green maximize button → original dimensions; equal traffic-light spacing")
        let ui = RenderedControls(application: application, screenshot: temporary.appendingPathComponent("window.png"))
        try click(windowButton(kAXCloseButtonAttribute))
        _ = try ui.waitFor("退出应用")
        if let screenshot = ProcessInfo.processInfo.environment["OMP_CLOSE_SMOKE_SCREENSHOT"] {
            try FileManager.default.copyItem(at: ui.screenshot, to: URL(fileURLWithPath: screenshot))
        }
        try click(ui.waitFor("取消"))
        let deadline = Date().addingTimeInterval(10)
        while try ui.locate("退出应用") != nil {
            if Date() >= deadline { throw SmokeFailure("Cancel did not dismiss the original modal") }
            Thread.sleep(forTimeInterval: 0.2)
        }
        guard process.isRunning, !elements(application, kAXWindowsAttribute).isEmpty else { throw SmokeFailure("Cancel closed the application") }
        print("PASS: original application close dialog → Cancel")
        try click(windowButton(kAXCloseButtonAttribute))
        try click(ui.waitFor("最小化到托盘"))
        try waitFor("Background choice did not keep the window hidden") { elements(application, kAXWindowsAttribute).isEmpty }
        Thread.sleep(forTimeInterval: 1)
        guard process.isRunning, elements(application, kAXWindowsAttribute).isEmpty else { throw SmokeFailure("Hidden window immediately reopened") }
        print("PASS: original application close dialog → background, without reopening")
        let menuBars = elements(application, kAXChildrenAttribute).filter { attribute($0, kAXRoleAttribute) as? String == kAXMenuBarRole }
        guard let tray = menuBars.flatMap({ elements($0, kAXChildrenAttribute) }).first(where: { attribute($0, kAXSubroleAttribute) as? String == "AXMenuExtra" }) else { throw SmokeFailure("Tray restore control missing") }
        try click(tray)
        try waitFor("Tray click did not restore the hidden window") { !elements(application, kAXWindowsAttribute).isEmpty }
        print("PASS: tray click → restored window")
        try click(windowButton(kAXCloseButtonAttribute))
        try click(ui.waitFor("退出应用"))
        try waitFor("Exit did not terminate the packaged application", timeout: 30) { !process.isRunning }
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw SmokeFailure("Application exited with status \(process.terminationStatus)") }
        try waitFor("Exit left its managed daemon running") { kill(daemonPID, 0) != 0 && errno == ESRCH }
        print("PASS: system mouse close → original application modal → cancel/background → tray restore → exit; managed daemon stopped")
    } catch {
        if let text = try? String(contentsOf: log, encoding: .utf8) { fputs(text, stderr) }
        throw error
    }
}

do { try run() } catch {
    fputs("FAIL: \(error)\n", stderr)
    exit(1)
}
