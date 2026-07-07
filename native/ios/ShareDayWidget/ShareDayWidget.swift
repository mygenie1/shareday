import WidgetKit
import SwiftUI
import AppIntents

struct ShareEntry: TimelineEntry {
    let date: Date
    let calendarName: String
    let kindCount: Int          // number of configured calendars (drives the switch button)
    let events: [WEvent]
    let errorText: String?
}

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> ShareEntry {
        ShareEntry(date: Date(), calendarName: "셰어데이", kindCount: 1,
                   events: [WEvent(title: "오늘 일정", timeLabel: "10:00", colorHex: "#10B981", catName: "약속")],
                   errorText: nil)
    }
    func getSnapshot(in context: Context, completion: @escaping (ShareEntry) -> Void) {
        fetchEntry(completion: completion)
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<ShareEntry>) -> Void) {
        // battery-friendly: refresh ~45 min out (directive: 30m–1h)
        fetchEntry { entry in
            let next = Calendar.current.date(byAdding: .minute, value: 45, to: Date()) ?? Date().addingTimeInterval(2700)
            completion(Timeline(entries: [entry], policy: .after(next)))
        }
    }
}

// iOS 17+ interactive widget: tap to switch to the next configured calendar.
@available(iOS 17.0, *)
struct CycleCalendarIntent: AppIntent {
    static var title: LocalizedStringResource = "다음 캘린더"
    func perform() async throws -> some IntentResult {
        if let cfg = loadConfig(), cfg.tokens.count > 1 {
            saveSelectedIndex((cfg.selectedIndex + 1) % cfg.tokens.count)
            WidgetCenter.shared.reloadAllTimelines()
        }
        return .result()
    }
}

struct ShareDayWidgetView: View {
    var entry: ShareEntry
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(entry.calendarName).font(.caption).bold().lineLimit(1).foregroundStyle(.secondary)
                Spacer()
                if #available(iOS 17.0, *), entry.kindCount > 1 {
                    Button(intent: CycleCalendarIntent()) {
                        Image(systemName: "arrow.triangle.2.circlepath").font(.caption2)
                    }.buttonStyle(.plain).foregroundStyle(.secondary)
                }
            }
            if let err = entry.errorText {
                Spacer(); Text(err).font(.caption2).foregroundStyle(.secondary); Spacer()
            } else if entry.events.isEmpty {
                Spacer(); Text("오늘 공개된 일정이 없어요.").font(.caption2).foregroundStyle(.secondary); Spacer()
            } else {
                ForEach(entry.events.prefix(4)) { ev in
                    HStack(spacing: 6) {
                        Circle().fill(Color(hex: ev.colorHex)).frame(width: 7, height: 7)
                        Text(ev.title).font(.caption2).bold().lineLimit(1)
                        Spacer(minLength: 6)
                        Text(ev.timeLabel).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                if entry.events.count > 4 {
                    Text("+\(entry.events.count - 4)개 더").font(.caption2).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
        }
        .padding(12)
        .widgetURL(URL(string: "shareday://calendar"))   // tap → open the app
    }
}

@main
struct ShareDayWidget: Widget {
    let kind = "ShareDayWidget"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: Provider()) { entry in
            if #available(iOS 17.0, *) {
                ShareDayWidgetView(entry: entry).containerBackground(.fill.tertiary, for: .widget)
            } else {
                ShareDayWidgetView(entry: entry).padding()
            }
        }
        .configurationDisplayName("셰어데이")
        .description("공개 캘린더의 오늘 일정을 보여줘요.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}
