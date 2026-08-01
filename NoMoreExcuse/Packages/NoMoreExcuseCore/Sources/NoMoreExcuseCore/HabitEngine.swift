import Foundation

public enum HabitEngine {
    public static func dateKey(for date: Date, calendar: Calendar = .current) -> String {
        let values = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", values.year ?? 0, values.month ?? 0, values.day ?? 0)
    }

    public static func isScheduled(_ habit: Habit, on date: Date, calendar: Calendar = .current) -> Bool {
        habit.schedule.weekdays.isEmpty || habit.schedule.weekdays.contains(calendar.component(.weekday, from: date))
    }

    public static func log(for habitID: UUID, on date: Date, logs: [HabitLog], calendar: Calendar = .current) -> HabitLog? {
        let key = dateKey(for: date, calendar: calendar)
        return logs.last { $0.habitID == habitID && $0.dateKey == key }
    }

    public static func progress(for habit: Habit, on date: Date, logs: [HabitLog], calendar: Calendar = .current) -> Double {
        guard let log = log(for: habit.id, on: date, logs: logs, calendar: calendar) else { return 0 }
        if log.state == .completed { return 1 }
        return min(max(log.value / max(habit.target, 0.01), 0), 1)
    }

    public static func isComplete(_ habit: Habit, on date: Date, logs: [HabitLog], calendar: Calendar = .current) -> Bool {
        guard isScheduled(habit, on: date, calendar: calendar),
              let log = log(for: habit.id, on: date, logs: logs, calendar: calendar) else { return false }
        return log.state == .completed || log.value >= habit.target
    }

    public static func dailyScore(habits: [Habit], logs: [HabitLog], on date: Date, calendar: Calendar = .current) -> Double {
        let due = habits.filter { !$0.isArchived && isScheduled($0, on: date, calendar: calendar) }
        guard !due.isEmpty else { return 0 }
        let total = due.reduce(0.0) { $0 + progress(for: $1, on: date, logs: logs, calendar: calendar) }
        return total / Double(due.count)
    }

    public static func streak(for habit: Habit, through date: Date, logs: [HabitLog], calendar: Calendar = .current) -> Int {
        var cursor = calendar.startOfDay(for: date)
        var streak = 0
        var inspected = 0

        while inspected < 730 {
            inspected += 1
            if isScheduled(habit, on: cursor, calendar: calendar) {
                if isComplete(habit, on: cursor, logs: logs, calendar: calendar) {
                    streak += 1
                } else {
                    break
                }
            }
            guard let previous = calendar.date(byAdding: .day, value: -1, to: cursor) else { break }
            cursor = previous
        }
        return streak
    }

    public static func weekDates(containing date: Date, firstWeekday: Int = 7, calendar input: Calendar = .current) -> [Date] {
        var calendar = input
        calendar.firstWeekday = min(max(firstWeekday, 1), 7)
        guard let interval = calendar.dateInterval(of: .weekOfYear, for: date) else { return [] }
        return (0..<7).compactMap { calendar.date(byAdding: .day, value: $0, to: interval.start) }
    }

    public static func lastDates(count: Int, through date: Date, calendar: Calendar = .current) -> [Date] {
        guard count > 0 else { return [] }
        return (0..<count).compactMap { offset in
            calendar.date(byAdding: .day, value: -(count - 1 - offset), to: calendar.startOfDay(for: date))
        }
    }
}
