import WidgetKit
import SwiftUI
import AppIntents

/// Two home-screen widgets, both rendered from the App Group snapshot (see
/// WidgetData.swift). No network: everything they show is already on the device.
///
/// The extension targets iOS 17 so that AppIntentConfiguration (long-press → 설정)
/// and the interactive ↻ button are both available without availability branches.
/// On iOS 16 and below the widgets simply don't appear in the gallery; the app itself
/// still runs (its own deployment target is unchanged).

// ---------- choosing which calendar a widget shows ----------

struct WidgetTargetEntity: AppEntity, Identifiable, Hashable {
    let id: Int                 // index into snapshot.targets
    let name: String

    static var typeDisplayRepresentation: TypeDisplayRepresentation { "캘린더" }
    static var defaultQuery = WidgetTargetQuery()
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}

struct WidgetTargetQuery: EntityQuery {
    private func all() -> [WidgetTargetEntity] {
        let snap = loadSnapshot()
        let targets = snap?.targets ?? [WTarget(kind: "mine", name: "내 일정", token: nil)]
        return targets.enumerated().map { WidgetTargetEntity(id: $0.offset, name: $0.element.name) }
    }
    func entities(for identifiers: [Int]) async throws -> [WidgetTargetEntity] {
        all().filter { identifiers.contains($0.id) }
    }
    func suggestedEntities() async throws -> [WidgetTargetEntity] { all() }
    func defaultResult() async -> WidgetTargetEntity? { all().first }
}

/// Long-press → 위젯 편집. Leaving 캘린더 unset means "follow the app's choice", which
/// is what the ↻ button moves; picking one here pins this widget to that calendar.
struct SelectTargetIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "캘린더 선택"
    static var description = IntentDescription("위젯에 보여줄 캘린더를 고르세요. 비워 두면 앱에서 고른 캘린더를 따라가요.")

    @Parameter(title: "캘린더")
    var target: WidgetTargetEntity?
}

/// The ↻ button: advance the app-wide selection to the next calendar.
struct CycleCalendarIntent: AppIntent {
    static var title: LocalizedStringResource = "다음 캘린더"
    func perform() async throws -> some IntentResult {
        if let snap = loadSnapshot(), snap.targets.count > 1 {
            saveSelectedIndex((snap.selectedIndex + 1) % snap.targets.count)
            WidgetCenter.shared.reloadAllTimelines()
        }
        return .result()
    }
}

// ---------- timeline ----------

struct ShareEntry: TimelineEntry {
    let date: Date
    let calendarName: String
    let targetCount: Int
    let pinned: Bool            // configured via long-press → the ↻ button is hidden
    let events: [WEvent]
    let weekStart: Int
    let emptyText: String?
}

private func makeEntry(_ configuration: SelectTargetIntent, now: Date = Date()) -> ShareEntry {
    guard let snap = loadSnapshot(), !snap.targets.isEmpty else {
        return ShareEntry(date: now, calendarName: "셰어데이", targetCount: 0, pinned: false,
                          events: [], weekStart: 0, emptyText: "앱을 한 번 열면 일정이 표시돼요.")
    }
    let pinnedIdx = configuration.target?.id
    let idx = snap.clampedIndex(pinnedIdx ?? snap.selectedIndex)
    return ShareEntry(date: now,
                      calendarName: snap.target(at: idx)?.name ?? "셰어데이",
                      targetCount: snap.targets.count,
                      pinned: pinnedIdx != nil,
                      events: snap.events(for: idx),
                      weekStart: snap.weekStart,
                      emptyText: nil)
}

struct Provider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> ShareEntry {
        ShareEntry(date: Date(), calendarName: "내 일정", targetCount: 1, pinned: false,
                   events: [], weekStart: 0, emptyText: nil)
    }
    func snapshot(for configuration: SelectTargetIntent, in context: Context) async -> ShareEntry {
        makeEntry(configuration)
    }
    /// Nothing to fetch, so the only reason to refresh is the date rolling over.
    func timeline(for configuration: SelectTargetIntent, in context: Context) async -> Timeline<ShareEntry> {
        let entry = makeEntry(configuration)
        let cal = widgetCalendar(weekStart: entry.weekStart)
        return Timeline(entries: [entry], policy: .after(nextMidnight(from: Date(), calendar: cal)))
    }
}

// ---------- shared chrome ----------

struct WidgetHeader: View {
    let entry: ShareEntry
    var body: some View {
        HStack(spacing: 6) {
            Text(entry.calendarName)
                .font(.caption).bold().lineLimit(1)
                .foregroundStyle(.secondary)
            Spacer(minLength: 4)
            if entry.targetCount > 1 && !entry.pinned {
                Button(intent: CycleCalendarIntent()) {
                    Image(systemName: "arrow.triangle.2.circlepath").font(.caption2)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
            }
        }
    }
}

// ---------- widget A: this month ----------

struct MonthWidgetView: View {
    let entry: ShareEntry

    private var cal: Calendar { widgetCalendar(weekStart: entry.weekStart) }

    /// The 6×7 grid the web calendar draws: the month, padded out to whole weeks.
    private var gridDays: [Date?] {
        let now = Date()
        guard let monthStart = cal.date(from: cal.dateComponents([.year, .month], from: now)),
              let range = cal.range(of: .day, in: .month, for: now) else { return [] }
        let lead = (cal.component(.weekday, from: monthStart) - cal.firstWeekday + 7) % 7
        var out: [Date?] = Array(repeating: nil, count: lead)
        for d in range { out.append(cal.date(byAdding: .day, value: d - 1, to: monthStart)) }
        while out.count % 7 != 0 { out.append(nil) }
        return out
    }

    private var dotsByDay: [String: [Color]] {
        Dictionary(grouping: entry.events, by: { $0.date })
            .mapValues { $0.prefix(3).map { Color(hex: $0.color) } }
    }

    private var dowSymbols: [String] {
        let base = ["일", "월", "화", "수", "목", "금", "토"]
        let shift = cal.firstWeekday - 1
        return (0..<7).map { base[($0 + shift) % 7] }
    }

    var body: some View {
        let days = gridDays
        let dots = dotsByDay
        let todayIso = ymd(Date())

        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text("\(cal.component(.month, from: Date()))월").font(.caption).bold()
                WidgetHeader(entry: entry)
            }
            HStack(spacing: 0) {
                ForEach(Array(dowSymbols.enumerated()), id: \.offset) { i, s in
                    Text(s)
                        .font(.system(size: 8))
                        .foregroundStyle(i == 0 ? Color.red.opacity(0.7) : .secondary)
                        .frame(maxWidth: .infinity)
                }
            }
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 1), count: 7), spacing: 3) {
                ForEach(Array(days.enumerated()), id: \.offset) { _, day in
                    if let day {
                        let iso = ymd(day)
                        VStack(spacing: 1) {
                            Text("\(cal.component(.day, from: day))")
                                .font(.system(size: 10, weight: iso == todayIso ? .bold : .regular))
                                .foregroundStyle(iso == todayIso ? Color.accentColor : .primary)
                            HStack(spacing: 1) {
                                ForEach(Array((dots[iso] ?? []).enumerated()), id: \.offset) { _, c in
                                    Circle().fill(c).frame(width: 3, height: 3)
                                }
                            }
                            .frame(height: 3)
                        }
                    } else {
                        Color.clear.frame(height: 16)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(10)
        .widgetURL(URL(string: "shareday://calendar"))
    }
}

struct ShareDayMonthWidget: Widget {
    let kind = "ShareDayMonthWidget"
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: kind, intent: SelectTargetIntent.self, provider: Provider()) { entry in
            MonthWidgetView(entry: entry).containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("이번 달")
        .description("이번 달 달력과 일정이 있는 날을 보여줘요.")
        .supportedFamilies([.systemMedium, .systemLarge])
    }
}

// ---------- widget B: this week ----------

struct WeekWidgetView: View {
    let entry: ShareEntry

    private var weekEvents: [WEvent] {
        let cal = widgetCalendar(weekStart: entry.weekStart)
        let now = Date()
        guard let start = cal.dateInterval(of: .weekOfYear, for: now)?.start,
              let end = cal.date(byAdding: .day, value: 6, to: start) else { return [] }
        let from = ymd(start), to = ymd(end)
        return entry.events.filter { $0.date >= from && $0.date <= to }
    }

    private func dayLabel(_ iso: String) -> String {
        let parts = iso.split(separator: "-")
        guard parts.count == 3 else { return iso }
        return "\(Int(parts[1]) ?? 0).\(Int(parts[2]) ?? 0)"
    }

    var body: some View {
        let evs = weekEvents
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                Text("이번 주").font(.caption).bold()
                WidgetHeader(entry: entry)
            }
            if let empty = entry.emptyText {
                Spacer()
                Text(empty).font(.caption2).foregroundStyle(.secondary)
                Spacer()
            } else if evs.isEmpty {
                Spacer()
                Text("이번 주 일정이 없어요.").font(.caption2).foregroundStyle(.secondary)
                Spacer()
            } else {
                ForEach(evs.prefix(5)) { ev in
                    HStack(spacing: 5) {
                        Circle().fill(Color(hex: ev.color)).frame(width: 6, height: 6)
                        Text(dayLabel(ev.date))
                            .font(.system(size: 10)).foregroundStyle(.secondary)
                            .frame(width: 26, alignment: .leading)
                        Text(ev.title).font(.caption2).bold().lineLimit(1)
                        Spacer(minLength: 4)
                        Text(ev.timeLabel)
                            .font(.system(size: 9)).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                if evs.count > 5 {
                    Text("+\(evs.count - 5)개 더").font(.system(size: 9)).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
        }
        .padding(10)
        .widgetURL(URL(string: "shareday://calendar"))
    }
}

struct ShareDayWeekWidget: Widget {
    let kind = "ShareDayWeekWidget"
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: kind, intent: SelectTargetIntent.self, provider: Provider()) { entry in
            WeekWidgetView(entry: entry).containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("이번 주")
        .description("이번 주 일정을 시간순으로 보여줘요.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

@main
struct ShareDayWidgetBundle: WidgetBundle {
    var body: some Widget {
        ShareDayMonthWidget()
        ShareDayWeekWidget()
    }
}
