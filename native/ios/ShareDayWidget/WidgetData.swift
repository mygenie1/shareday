import Foundation
import SwiftUI

/// The widgets read a snapshot the app writes into the App Group and nothing else —
/// there is no network here on purpose. Private events reach this file only when the
/// user turned "비공개 일정 포함" on in the app; when it is off they are dropped from
/// the payload before it is written, so they are not present to leak.
///
/// The app writes this through the WidgetBridge Capacitor plugin (see calendar.js,
/// pushWidgetIOS). Key is v2: Android still owns the legacy `shareday_widget` key.
let APP_GROUP = "group.com.mygenie.shareday"
let WIDGET_KEY = "shareday_widget_v2"

struct WTarget: Codable, Hashable {
    let kind: String            // "mine" | "friend"
    let name: String
    let token: String?
}

struct WEvent: Codable, Identifiable, Hashable {
    let targetIndex: Int
    let date: String            // yyyy-MM-dd
    let time: String            // "" = all-day
    let end: String
    let title: String
    let color: String           // already resolved from the category by the app
    let isPrivate: Bool

    var id: String { "\(targetIndex)|\(date)|\(time)|\(title)" }
    var timeLabel: String {
        if time.isEmpty { return "종일" }
        return end.isEmpty ? time : "\(time)–\(end)"
    }
}

struct WidgetSnapshot: Codable {
    let version: Int
    let savedAt: Double
    let weekStart: Int          // 0 = Sunday, matching the web calendar
    let includePrivate: Bool
    let selectedIndex: Int
    let targets: [WTarget]
    let events: [WEvent]
}

func sharedDefaults() -> UserDefaults? { UserDefaults(suiteName: APP_GROUP) }

func loadSnapshot() -> WidgetSnapshot? {
    guard let d = sharedDefaults(), let s = d.string(forKey: WIDGET_KEY),
          let data = s.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(WidgetSnapshot.self, from: data)
}

/// Used by the in-widget ↻ button. Only the index is rewritten; the events stay put,
/// so switching calendars costs no network and no round-trip through the app.
func saveSelectedIndex(_ i: Int) {
    guard let d = sharedDefaults(), let s = d.string(forKey: WIDGET_KEY),
          let data = s.data(using: .utf8),
          var obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
    obj["selectedIndex"] = i
    if let out = try? JSONSerialization.data(withJSONObject: obj),
       let str = String(data: out, encoding: .utf8) {
        d.set(str, forKey: WIDGET_KEY)
    }
}

// ---------- dates: the widget's own calendar, pinned to a Sunday week start ----------

func widgetCalendar(weekStart: Int) -> Calendar {
    var c = Calendar(identifier: .gregorian)
    c.firstWeekday = weekStart + 1          // Calendar is 1-based: 1 = Sunday
    c.timeZone = .current
    return c
}

private let ymdFormatter: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd"
    f.calendar = Calendar(identifier: .gregorian)
    f.timeZone = .current
    return f
}()

func ymd(_ d: Date) -> String { ymdFormatter.string(from: d) }

/// Midnight, so a widget showing "today" flips over at the right moment.
func nextMidnight(from date: Date, calendar: Calendar) -> Date {
    calendar.nextDate(after: date, matching: DateComponents(hour: 0, minute: 0, second: 0),
                      matchingPolicy: .nextTime) ?? date.addingTimeInterval(3600)
}

extension WidgetSnapshot {
    func clampedIndex(_ i: Int) -> Int {
        guard !targets.isEmpty else { return 0 }
        return max(0, min(i, targets.count - 1))
    }
    func target(at i: Int) -> WTarget? {
        targets.isEmpty ? nil : targets[clampedIndex(i)]
    }
    func events(for i: Int) -> [WEvent] {
        let idx = clampedIndex(i)
        return events.filter { $0.targetIndex == idx }
    }
}

extension Color {
    init(hex: String) {
        var s = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
        var v: UInt64 = 0
        Scanner(string: s).scanHexInt64(&v)
        self = Color(.sRGB,
                     red: Double((v >> 16) & 0xff) / 255,
                     green: Double((v >> 8) & 0xff) / 255,
                     blue: Double(v & 0xff) / 255)
    }
}
