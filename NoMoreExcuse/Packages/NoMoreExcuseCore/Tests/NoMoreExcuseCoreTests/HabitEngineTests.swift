import Testing
import Foundation
@testable import NoMoreExcuseCore

struct HabitEngineTests {
    private var calendar: Calendar {
        var value = Calendar(identifier: .gregorian)
        value.timeZone = TimeZone(secondsFromGMT: 0)!
        return value
    }

    private func date(_ year: Int, _ month: Int, _ day: Int) -> Date {
        calendar.date(from: DateComponents(year: year, month: month, day: day, hour: 12))!
    }

    @Test func dateKeyIsStable() {
        #expect(HabitEngine.dateKey(for: date(2026, 8, 2), calendar: calendar) == "2026-08-02")
    }

    @Test func dailyScoreUsesPartialProgress() {
        let water = Habit(title: "Water", metric: .count, target: 4)
        let reading = Habit(title: "Read")
        let day = date(2026, 8, 2)
        let logs = [
            HabitLog(habitID: water.id, dateKey: "2026-08-02", value: 2),
            HabitLog(habitID: reading.id, dateKey: "2026-08-02", value: 1, state: .completed)
        ]

        let score = HabitEngine.dailyScore(habits: [water, reading], logs: logs, on: day, calendar: calendar)
        #expect(abs(score - 0.75) < 0.001)
    }

    @Test func streakSkipsUnscheduledDays() {
        // Monday, Wednesday, Friday.
        let habit = Habit(title: "Run", schedule: HabitSchedule(weekdays: [2, 4, 6]))
        let friday = date(2026, 7, 31)
        let logs = [
            HabitLog(habitID: habit.id, dateKey: "2026-07-31", value: 1, state: .completed),
            HabitLog(habitID: habit.id, dateKey: "2026-07-29", value: 1, state: .completed),
            HabitLog(habitID: habit.id, dateKey: "2026-07-27", value: 1, state: .completed)
        ]

        #expect(HabitEngine.streak(for: habit, through: friday, logs: logs, calendar: calendar) == 3)
    }
}
