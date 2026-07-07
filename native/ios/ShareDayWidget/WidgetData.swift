import Foundation
import SwiftUI

// Shared with the app via an App Group. The app writes the JSON config here through
// the WidgetBridge Capacitor plugin; the widget reads it and fetches the public
// snapshot from the server. PUBLIC events only — private events never leave the app.
let APP_GROUP = "group.com.shareday.app"
let WIDGET_KEY = "shareday_widget"
let DEFAULT_BASE = "https://shareday-seven.vercel.app"

struct WCalendarRef: Codable { let token: String; let name: String? }
struct WidgetConfig: Codable { var tokens: [WCalendarRef]; var selectedIndex: Int; var base: String? }

struct WEvent: Identifiable {
    let id = UUID()
    let title: String
    let timeLabel: String
    let colorHex: String
    let catName: String?
}

func sharedDefaults() -> UserDefaults? { UserDefaults(suiteName: APP_GROUP) }

func loadConfig() -> WidgetConfig? {
    guard let d = sharedDefaults(), let s = d.string(forKey: WIDGET_KEY),
          let data = s.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(WidgetConfig.self, from: data)
}

// used by the in-widget "next calendar" button (see CycleCalendarIntent)
func saveSelectedIndex(_ i: Int) {
    guard var cfg = loadConfig(), let d = sharedDefaults() else { return }
    cfg.selectedIndex = i
    if let data = try? JSONEncoder().encode(cfg), let s = String(data: data, encoding: .utf8) {
        d.set(s, forKey: WIDGET_KEY)
    }
}

// server snapshot shape (GET /api/share/[token])
private struct SnapCategory: Codable { let id: String; let name: String?; let color: String? }
private struct SnapEvent: Codable { let id: String?; let date: String; let time: String?; let end: String?; let title: String?; let catId: String? }
private struct Snapshot: Codable { let events: [SnapEvent]?; let categories: [SnapCategory]?; let expiresAt: String? }

private func todayYmd() -> String {
    let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.timeZone = .current
    return f.string(from: Date())
}

/// Read config → fetch selected token's public snapshot → today's public events.
func fetchEntry(completion: @escaping (ShareEntry) -> Void) {
    let cfg = loadConfig()
    let count = cfg?.tokens.count ?? 0
    guard let cfg = cfg, count > 0 else {
        completion(ShareEntry(date: Date(), calendarName: "셰어데이", kindCount: 0, events: [],
                              errorText: "위젯에 표시할 캘린더를 앱에서 골라 주세요.")); return
    }
    let idx = max(0, min(cfg.selectedIndex, count - 1))
    let ref = cfg.tokens[idx]
    let base = cfg.base ?? DEFAULT_BASE
    let name = ref.name ?? "공유 캘린더"
    guard let url = URL(string: "\(base)/api/share/\(ref.token)") else {
        completion(ShareEntry(date: Date(), calendarName: name, kindCount: count, events: [],
                              errorText: "주소가 올바르지 않아요.")); return
    }
    URLSession.shared.dataTask(with: url) { data, resp, _ in
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if code == 404 || code == 410 {
            completion(ShareEntry(date: Date(), calendarName: name, kindCount: count, events: [],
                                  errorText: "링크가 만료됐어요.")); return
        }
        guard let data = data, let snap = try? JSONDecoder().decode(Snapshot.self, from: data) else {
            // network hiccup → keep last shown (no error text)
            completion(ShareEntry(date: Date(), calendarName: name, kindCount: count, events: [], errorText: nil)); return
        }
        var catMap: [String: SnapCategory] = [:]
        (snap.categories ?? []).forEach { catMap[$0.id] = $0 }
        let today = todayYmd()
        let evs = (snap.events ?? [])
            .filter { $0.date == today }
            .sorted { ($0.time ?? "99") < ($1.time ?? "99") }
            .map { e -> WEvent in
                let c = e.catId.flatMap { catMap[$0] }
                let timeLabel = e.time.map { $0 + (e.end.map { "–" + $0 } ?? "") } ?? "종일"
                return WEvent(title: e.title ?? "제목 없음", timeLabel: timeLabel,
                              colorHex: c?.color ?? "#64748B", catName: c?.name)
            }
        completion(ShareEntry(date: Date(), calendarName: name, kindCount: count, events: evs, errorText: nil))
    }.resume()
}

extension Color {
    init(hex: String) {
        var s = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
        var v: UInt64 = 0; Scanner(string: s).scanHexInt64(&v)
        self = Color(.sRGB,
                     red: Double((v >> 16) & 0xff) / 255,
                     green: Double((v >> 8) & 0xff) / 255,
                     blue: Double(v & 0xff) / 255)
    }
}
