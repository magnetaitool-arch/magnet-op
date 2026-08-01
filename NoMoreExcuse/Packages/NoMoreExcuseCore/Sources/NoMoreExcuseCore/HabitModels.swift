import Foundation

public enum HabitMetric: String, Codable, CaseIterable, Identifiable, Sendable {
    case check
    case count
    case duration
    case avoid

    public var id: String { rawValue }

    public var defaultUnit: String {
        switch self {
        case .check: return "done"
        case .count: return "times"
        case .duration: return "minutes"
        case .avoid: return "clean day"
        }
    }
}

public struct HabitSchedule: Codable, Equatable, Sendable {
    /// Calendar weekday values: 1 = Sunday ... 7 = Saturday. Empty means every day.
    public var weekdays: [Int]

    public init(weekdays: [Int] = []) {
        self.weekdays = Array(Set(weekdays.filter { (1...7).contains($0) })).sorted()
    }

    public static let daily = HabitSchedule()
}

public struct Habit: Identifiable, Codable, Equatable, Sendable {
    public var id: UUID
    public var title: String
    public var note: String
    public var emoji: String
    public var colorHex: String
    public var metric: HabitMetric
    public var target: Double
    public var unit: String
    public var schedule: HabitSchedule
    public var reminderHour: Int?
    public var reminderMinute: Int?
    public var isArchived: Bool
    public var createdAt: Date

    public init(
        id: UUID = UUID(),
        title: String,
        note: String = "",
        emoji: String = "⚡️",
        colorHex: String = "5B5CF6",
        metric: HabitMetric = .check,
        target: Double = 1,
        unit: String? = nil,
        schedule: HabitSchedule = .daily,
        reminderHour: Int? = nil,
        reminderMinute: Int? = nil,
        isArchived: Bool = false,
        createdAt: Date = .now
    ) {
        self.id = id
        self.title = title
        self.note = note
        self.emoji = emoji
        self.colorHex = colorHex
        self.metric = metric
        self.target = max(target, metric == .avoid ? 1 : 0.01)
        self.unit = unit ?? metric.defaultUnit
        self.schedule = schedule
        self.reminderHour = reminderHour
        self.reminderMinute = reminderMinute
        self.isArchived = isArchived
        self.createdAt = createdAt
    }
}

public enum HabitLogState: String, Codable, Sendable {
    case progress
    case completed
    case skipped
    case failed
}

public struct HabitLog: Identifiable, Codable, Equatable, Sendable {
    public var id: UUID
    public var habitID: UUID
    public var dateKey: String
    public var value: Double
    public var state: HabitLogState
    public var updatedAt: Date

    public init(
        id: UUID = UUID(),
        habitID: UUID,
        dateKey: String,
        value: Double,
        state: HabitLogState = .progress,
        updatedAt: Date = .now
    ) {
        self.id = id
        self.habitID = habitID
        self.dateKey = dateKey
        self.value = max(0, value)
        self.state = state
        self.updatedAt = updatedAt
    }
}

public struct HabitSnapshot: Codable, Sendable {
    public var habits: [Habit]
    public var logs: [HabitLog]

    public init(habits: [Habit] = [], logs: [HabitLog] = []) {
        self.habits = habits
        self.logs = logs
    }
}
