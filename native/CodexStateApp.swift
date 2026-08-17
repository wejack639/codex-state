import Cocoa
import UserNotifications
import WebKit

private struct RuntimeConfig: Decodable {
    let projectRoot: String
    let nodePath: String
}

private struct PetManifest: Decodable {
    let spriteVersionNumber: Int?
    let spritesheetPath: String
}

final class FloatingPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler, UNUserNotificationCenterDelegate {
    private let collapsedSize = NSSize(width: 112, height: 128)
    private let panelAnchorXKey = "CodexStatePanelAnchorX.v2"
    private let panelAnchorYKey = "CodexStatePanelAnchorY.v2"
    private var panel: FloatingPanel!
    private var webView: WKWebView!
    private var dashboardProcess: Process?
    private var logHandle: FileHandle?
    private var dashboardLoaded = false
    private var expansionSuppressedUntil = Date.distantPast
    private var dragStartScreenPoint: NSPoint?
    private var dragStartFrame: NSRect?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        createFloatingPanel()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(screenParametersDidChange),
            name: NSApplication.didChangeScreenParametersNotification,
            object: nil
        )
        showLoading(message: "正在连接本机 Codex…")
        startDashboard()
        configureNotifications()
        waitForDashboard(attempt: 0)
    }

    func applicationWillTerminate(_ notification: Notification) {
        NotificationCenter.default.removeObserver(self)
        if dashboardProcess?.isRunning == true {
            dashboardProcess?.terminate()
            dashboardProcess?.waitUntilExit()
        }
        try? logHandle?.close()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationShouldHandleReopen(
        _ sender: NSApplication,
        hasVisibleWindows flag: Bool
    ) -> Bool {
        panel.makeKeyAndOrderFront(nil)
        panel.orderFrontRegardless()
        return true
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        ensurePanelIsVisible()
    }

    @objc private func screenParametersDidChange() {
        DispatchQueue.main.async { [weak self] in
            self?.ensurePanelIsVisible()
        }
    }

    private func createFloatingPanel() {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(self, name: "panel")
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.underPageBackgroundColor = .clear
        webView.setValue(false, forKey: "drawsBackground")
        webView.wantsLayer = true
        webView.layer?.backgroundColor = NSColor.clear.cgColor
        webView.layer?.cornerRadius = 0
        webView.layer?.cornerCurve = .continuous
        webView.layer?.masksToBounds = true

        panel = FloatingPanel(
            contentRect: NSRect(origin: .zero, size: collapsedSize),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        panel.title = "Codex State"
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isReleasedWhenClosed = false
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.acceptsMouseMovedEvents = true
        panel.animationBehavior = .utilityWindow
        panel.contentView = webView

        let visibleFrame = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let initialOrigin = restoredPanelOrigin() ?? NSPoint(
            x: visibleFrame.maxX - collapsedSize.width - 18,
            y: visibleFrame.maxY - collapsedSize.height - 18
        )
        panel.setFrame(NSRect(origin: initialOrigin, size: collapsedSize), display: true)
        panel.makeKeyAndOrderFront(nil)
        panel.orderFrontRegardless()
    }

    private func showLoading(message: String) {
        let visual: String
        let baseURL: URL?
        if let pet = currentPetLoadingAsset() {
            visual = """
            <div class="pet" role="img" aria-label="\(message)"></div>
            <style>
              .pet { width: 104px; height: 113px;
                background: url("\(pet.fileName)") 0 0 / 800% \(pet.rows * 100)% no-repeat;
                filter: drop-shadow(0 5px 5px rgba(0, 0, 0, .38)); }
            </style>
            """
            baseURL = pet.directoryURL
        } else {
            let iconSource: String
            if
                let iconURL = Bundle.main.url(forResource: "panel-icon", withExtension: "png"),
                let iconData = try? Data(contentsOf: iconURL)
            {
                iconSource = "data:image/png;base64,\(iconData.base64EncodedString())"
            } else {
                iconSource = ""
            }
            visual = "<img src=\"\(iconSource)\" alt=\"\(message)\">"
            baseURL = nil
        }
        let html = """
        <!doctype html>
        <html lang="zh-CN">
        <meta charset="utf-8">
        <style>
          * { box-sizing: border-box; }
          body { margin: 0; width: 112px; height: 128px; display: grid; place-items: center;
            overflow: hidden; background: transparent; }
          img { width: 104px; height: 120px; object-fit: contain;
            filter: drop-shadow(0 5px 5px rgba(0, 0, 0, .38)); }
        </style>
        \(visual)
        """
        webView.loadHTMLString(html, baseURL: baseURL)
    }

    private func currentPetLoadingAsset() -> (directoryURL: URL, fileName: String, rows: Int)? {
        guard
            let runtimeURL = Bundle.main.url(forResource: "runtime", withExtension: "json"),
            let runtimeData = try? Data(contentsOf: runtimeURL),
            let runtime = try? JSONDecoder().decode(RuntimeConfig.self, from: runtimeData)
        else { return nil }

        let directoryURL = URL(fileURLWithPath: runtime.projectRoot, isDirectory: true)
            .appendingPathComponent("public/pet", isDirectory: true)
        let manifestURL = directoryURL.appendingPathComponent("pet.json")
        guard
            let manifestData = try? Data(contentsOf: manifestURL),
            let manifest = try? JSONDecoder().decode(PetManifest.self, from: manifestData)
        else { return nil }

        let version = manifest.spriteVersionNumber ?? 1
        let fileName = manifest.spritesheetPath
        guard
            version == 1 || version == 2,
            fileName.range(
                of: #"^[A-Za-z0-9._-]+\.(png|webp)$"#,
                options: [.regularExpression, .caseInsensitive]
            ) != nil,
            FileManager.default.fileExists(atPath: directoryURL.appendingPathComponent(fileName).path)
        else { return nil }

        return (directoryURL, fileName, version == 2 ? 11 : 9)
    }

    private func startDashboard() {
        guard
            let runtimeURL = Bundle.main.url(forResource: "runtime", withExtension: "json"),
            let data = try? Data(contentsOf: runtimeURL),
            let runtime = try? JSONDecoder().decode(RuntimeConfig.self, from: data)
        else {
            showLoading(message: "无法读取本机启动配置")
            return
        }

        let stateDirectory = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".codex-state", isDirectory: true)
        try? FileManager.default.createDirectory(
            at: stateDirectory,
            withIntermediateDirectories: true
        )
        let logURL = stateDirectory.appendingPathComponent("floating.log")
        try? Data().write(to: logURL, options: .atomic)
        logHandle = try? FileHandle(forWritingTo: logURL)

        let process = Process()
        process.executableURL = URL(fileURLWithPath: runtime.nodePath)
        process.arguments = ["scripts/dashboard.mjs"]
        process.currentDirectoryURL = URL(fileURLWithPath: runtime.projectRoot, isDirectory: true)
        var environment = ProcessInfo.processInfo.environment
        environment["CODEX_STATE_NO_OPEN"] = "1"
        process.environment = environment
        process.standardOutput = logHandle
        process.standardError = logHandle

        do {
            try process.run()
            dashboardProcess = process
        } catch {
            showLoading(message: "本机服务启动失败")
        }
    }

    private func waitForDashboard(attempt: Int) {
        guard attempt < 120 else {
            showLoading(message: "连接超时，请查看 ~/.codex-state/floating.log")
            return
        }

        probe(url: URL(string: "http://127.0.0.1:43991/api/health")!) { [weak self] bridgeReady in
            guard let self else { return }
            self.probe(url: URL(string: "http://localhost:3000/")!) { [weak self] uiReady in
                DispatchQueue.main.async {
                    guard let self else { return }
                    if bridgeReady && uiReady {
                        self.loadDashboard()
                    } else {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                            self.waitForDashboard(attempt: attempt + 1)
                        }
                    }
                }
            }
        }
    }

    private func probe(url: URL, completion: @escaping (Bool) -> Void) {
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 1
        URLSession.shared.dataTask(with: request) { _, response, _ in
            completion((response as? HTTPURLResponse)?.statusCode == 200)
        }.resume()
    }

    private func loadDashboard() {
        dashboardLoaded = true
        webView.load(URLRequest(
            url: URL(string: "http://localhost:3000/?pet=1")!,
            cachePolicy: .reloadIgnoringLocalCacheData
        ))
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard message.name == "panel", let body = message.body as? [String: Any] else { return }
        switch body["type"] as? String {
        case "resize":
            let expanded = body["expanded"] as? Bool ?? false
            let width = (body["width"] as? NSNumber)?.doubleValue
            let height = (body["height"] as? NSNumber)?.doubleValue
            let suppressExpansionMs = (body["suppressExpansionMs"] as? NSNumber)?.doubleValue ?? 0
            resizePanel(
                expanded: expanded,
                requestedWidth: width,
                requestedHeight: height,
                suppressExpansionMs: suppressExpansionMs
            )
        case "dragStart":
            guard
                let screenX = (body["screenX"] as? NSNumber)?.doubleValue,
                let screenY = (body["screenY"] as? NSNumber)?.doubleValue
            else { return }
            beginPanelDrag(screenX: screenX, screenY: screenY)
        case "dragMove":
            guard
                let screenX = (body["screenX"] as? NSNumber)?.doubleValue,
                let screenY = (body["screenY"] as? NSNumber)?.doubleValue
            else { return }
            movePanelDrag(screenX: screenX, screenY: screenY)
        case "dragEnd":
            endPanelDrag()
        case "notify":
            guard
                let title = body["title"] as? String,
                let cwd = body["cwd"] as? String,
                let status = body["status"] as? String
            else { return }
            deliverNotification(title: title, cwd: cwd, status: status)
        default:
            break
        }
    }

    private func restoredPanelOrigin() -> NSPoint? {
        let defaults = UserDefaults.standard
        guard
            defaults.object(forKey: panelAnchorXKey) != nil,
            defaults.object(forKey: panelAnchorYKey) != nil
        else { return nil }

        let anchor = NSPoint(
            x: defaults.double(forKey: panelAnchorXKey),
            y: defaults.double(forKey: panelAnchorYKey)
        )
        let isOnKnownScreen = NSScreen.screens.contains { screen in
            screen.frame.insetBy(dx: -24, dy: -24).contains(anchor)
        }
        guard isOnKnownScreen else { return nil }
        return NSPoint(x: anchor.x - collapsedSize.width, y: anchor.y - collapsedSize.height)
    }

    private func savePanelAnchor() {
        let defaults = UserDefaults.standard
        defaults.set(panel.frame.maxX, forKey: panelAnchorXKey)
        defaults.set(panel.frame.maxY, forKey: panelAnchorYKey)
    }

    private func ensurePanelIsVisible() {
        guard panel != nil else { return }
        let frame = panel.frame
        let targetScreen = NSScreen.screens.max { first, second in
            let firstIntersection = first.visibleFrame.intersection(frame)
            let secondIntersection = second.visibleFrame.intersection(frame)
            return firstIntersection.width * firstIntersection.height
                < secondIntersection.width * secondIntersection.height
        } ?? NSScreen.main
        guard let visibleFrame = targetScreen?.visibleFrame else { return }

        let maxX = max(visibleFrame.minX, visibleFrame.maxX - frame.width)
        let maxY = max(visibleFrame.minY, visibleFrame.maxY - frame.height)
        let origin = NSPoint(
            x: min(max(frame.minX, visibleFrame.minX), maxX),
            y: min(max(frame.minY, visibleFrame.minY), maxY)
        )
        guard abs(origin.x - frame.minX) > 0.5 || abs(origin.y - frame.minY) > 0.5 else {
            return
        }
        panel.setFrameOrigin(origin)
        panel.orderFrontRegardless()
        savePanelAnchor()
    }

    private func beginPanelDrag(screenX: Double, screenY: Double) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.dragStartScreenPoint = NSPoint(x: CGFloat(screenX), y: CGFloat(screenY))
            self.dragStartFrame = self.panel.frame
        }
    }

    private func movePanelDrag(screenX: Double, screenY: Double) {
        DispatchQueue.main.async { [weak self] in
            guard
                let self,
                let startPoint = self.dragStartScreenPoint,
                let startFrame = self.dragStartFrame
            else { return }

            let deltaX = CGFloat(screenX) - startPoint.x
            let deltaY = CGFloat(screenY) - startPoint.y
            var proposedFrame = startFrame.offsetBy(dx: deltaX, dy: -deltaY)
            let targetScreen = NSScreen.screens.max { first, second in
                let firstIntersection = first.frame.intersection(proposedFrame)
                let secondIntersection = second.frame.intersection(proposedFrame)
                return firstIntersection.width * firstIntersection.height
                    < secondIntersection.width * secondIntersection.height
            } ?? self.panel.screen ?? NSScreen.main

            if let visibleFrame = targetScreen?.visibleFrame {
                let minimumVisible: CGFloat = 56
                proposedFrame.origin.x = min(
                    max(proposedFrame.origin.x, visibleFrame.minX - proposedFrame.width + minimumVisible),
                    visibleFrame.maxX - minimumVisible
                )
                proposedFrame.origin.y = min(
                    max(proposedFrame.origin.y, visibleFrame.minY - proposedFrame.height + minimumVisible),
                    visibleFrame.maxY - minimumVisible
                )
            }
            self.panel.setFrameOrigin(proposedFrame.origin)
            self.panel.orderFrontRegardless()
        }
    }

    private func endPanelDrag() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.dragStartScreenPoint = nil
            self.dragStartFrame = nil
            self.savePanelAnchor()
        }
    }

    private func configureNotifications() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.getNotificationSettings { settings in
            guard settings.authorizationStatus == .notDetermined else { return }
            center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
        }
    }

    private func deliverNotification(title: String, cwd: String, status: String) {
        let content = UNMutableNotificationContent()
        switch status {
        case "completed":
            content.title = "Codex 已运行完成"
        case "interrupted":
            content.title = "Codex 任务已中断"
        case "disconnected":
            content.title = "Codex 可能断联"
        default:
            return
        }
        content.subtitle = URL(fileURLWithPath: cwd).lastPathComponent
        content.body = title
        content.sound = .default
        content.threadIdentifier = cwd
        let request = UNNotificationRequest(
            identifier: "codex-state-\(UUID().uuidString)",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request)
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    private func resizePanel(
        expanded: Bool,
        requestedWidth: Double?,
        requestedHeight: Double?,
        suppressExpansionMs: Double
    ) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if !expanded && suppressExpansionMs > 0 {
                self.expansionSuppressedUntil = Date().addingTimeInterval(suppressExpansionMs / 1000)
            }
            if expanded && Date() < self.expansionSuppressedUntil {
                return
            }
            let oldFrame = self.panel.frame
            let visibleFrame = self.panel.screen?.visibleFrame
                ?? NSScreen.main?.visibleFrame
                ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
            let size: NSSize
            if expanded {
                size = NSSize(
                    width: min(max(requestedWidth ?? 430, 380), visibleFrame.width - 28),
                    height: min(max(requestedHeight ?? 480, 270), visibleFrame.height - 28)
                )
            } else {
                size = self.collapsedSize
            }
            self.webView.layer?.cornerRadius = expanded ? 22 : 0

            let newFrame = NSRect(
                x: oldFrame.maxX - size.width,
                y: oldFrame.maxY - size.height,
                width: size.width,
                height: size.height
            )
            guard abs(oldFrame.width - size.width) > 0.5 || abs(oldFrame.height - size.height) > 0.5 else {
                return
            }
            self.panel.setFrame(newFrame, display: true, animate: expanded)
            self.panel.orderFrontRegardless()
        }
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        guard dashboardLoaded else { return }
        dashboardLoaded = false
        showLoading(message: "正在重新连接面板…")
        waitForDashboard(attempt: 0)
    }

    func webView(
        _ webView: WKWebView,
        didFail navigation: WKNavigation!,
        withError error: Error
    ) {
        guard dashboardLoaded else { return }
        dashboardLoaded = false
        showLoading(message: "正在重新连接面板…")
        waitForDashboard(attempt: 0)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        if let url = navigationAction.request.url, url.scheme == "vscode" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.run()
