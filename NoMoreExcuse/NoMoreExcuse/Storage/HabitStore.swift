import Foundation
import SwiftUI
import NoMoreExcuseCore

@MainActor
final class HabitStore: ObservableObject {
    @Published var habits: [Habit] { didSet { persistIfReady() } }
    @Published var logs: [HabitLog] { didSet { persistIfReady() } }
    @Published var preferences: AppPreferences { didSet { persistPreferencesIfReady() } }
    @Published var selectedDate = Date.now

    private let snapshotURL: URL
    private let preferencesURL: URL
    private var isReady = false

    init() {
        let base = Self.storageDirectory()
        snapshotURL = base.appendingPathComponent("habits.json")
        preferencesURL = base.appendingPathComponent("preferences.json")

        if let data = try? Data(contentsOf: snapshotURL),
           let snapshot = try? JSONDecoder.app.decode(HabitSnapshot.self, from: data) {
            habits = snapshot.habits
            logs = snapshot.logs
        } else {
            let seed = Self.seedSnapshot()
            habits = seed.habits
            logs = seed.logs
        }

        if let data = try? Data(contentsOf: preferencesURL),
           let saved = try? JSONDecoder.app.decode(AppPreferences.self, from: data) {
            preferences = saved
        } else {
            preferences = AppPreferences()
        }
        isReady = true
        persist()
        persistPreferences()
    }

    var activeHabits: [Habit] { habits.filter { !$0.isArchived } }

    func scheduledHabits(on date: Date) -> [Habit] {
        activeHabits.filter { HabitEngine.isScheduled($0, on: date) }
    }

    func log(for habit: Habit, on date: Date? = nil) -> HabitLog? {
        HabitEngine.log(for: habit.id, on: date ?? selectedDate, logs: logs)
    }

    func progress(for habit: Habit, on date: Date? = nil) -> Double {
        HabitEngine.progress(for: habit, on: date ?? selectedDate, logs: logs)
    }

    func isComplete(_ habit: Habit, on date: Date? = nil) -> Bool {
        HabitEngine.isComplete(habit, on: date ?? selectedDate, logs: logs)
    }

    func streak(for habit: Habit) -> Int {
        HabitEngine.streak(for: habit, through: selectedDate, logs: logs)
    }

    func dailyScore(on date: Date? = nil) -> Double {
        HabitEngine.dailyScore(habits: activeHabits, logs: logs, on: date ?? selectedDate)
    }

    func add(_ habit: Habit) {
        habits.append(habit)
    }

    func update(_ habit: Habit) {
        guard let index = habits.firstIndex(where: { $0.id == habit.id }) else { return }
        habits[index] = habit
    }

    func archive(_ habit: Habit) {
        guard let index = habits.firstIndex(where: { $0.id == habit.id }) else { return }
        habits[index].isArchived = true
    }

    func toggle(_ habit: Habit, on date: Date? = nil) {
        let day = date ?? selectedDate
        if isComplete(habit, on: day) {
            record(habit, value: 0, state: .progress, on: day)
        } else {
            record(habit, value: habit.target, state: .completed, on: day)
        }
    }

    func increment(_ habit: Habit, by amount: Double = 1, on date: Date? = nil) {
        let day = date ?? selectedDate
        let next = min((log(for: habit, on: day)?.value ?? 0) + amount, habit.target)
        record(habit, value: next, state: next >= habit.target ? .completed : .progress, on: day)
    }

    func addDuration(_ seconds: Int, to habit: Habit, on date: Date? = nil) {
        increment(habit, by: Double(seconds) / 60.0, on: date)
    }

    func markFailed(_ habit: Habit, on date: Date? = nil) {
        record(habit, value: 0, state: .failed, on: date ?? selectedDate)
    }

    func resetDemoData() {
        let seed = Self.seedSnapshot()
        habits = seed.habits
        logs = seed.logs
        selectedDate = .now
    }

    func startFresh(with habit: Habit) {
        habits = [habit]
        logs = []
        selectedDate = .now
        preferences.hasCompletedOnboarding = true
    }

    func exportData() -> Data? {
        try? JSONEncoder.app.encode(HabitSnapshot(habits: habits, logs: logs))
    }

    private func record(_ habit: Habit, value: Double, state: HabitLogState, on date: Date) {
        let key = HabitEngine.dateKey(for: date)
        if let index = logs.lastIndex(where: { $0.habitID == habit.id && $0.dateKey == key }) {
            logs[index].value = max(0, value)
            logs[index].state = state
            logs[index].updatedAt = .now
        } else {
            logs.append(HabitLog(habitID: habit.id, dateKey: key, value: value, state: state))
        }
    }

    private func persistIfReady() { if isReady { persist() } }
    private func persistPreferencesIfReady() { if isReady { persistPreferences() } }

    private func persist() {
        let snapshot = HabitSnapshot(habits: habits, logs: logs)
        guard let data = try? JSONEncoder.app.encode(snapshot) else { return }
        try? data.write(to: snapshotURL, options: .atomic)
    }

    private func persistPreferences() {
        guard let data = try? JSONEncoder.app.encode(preferences) else { return }
        try? data.write(to: preferencesURL, options: .atomic)
    }

    private static func storageDirectory() -> URL {
        let fileManager = FileManager.default
        let root = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory
        let directory = root.appendingPathComponent("NoMoreExcuse", isDirectory: true)
        try? fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private static func seedSnapshot() -> HabitSnapshot {
        let meditate = Habit(title: "Meditate", note: "Breathe before the day gets loud.", emoji: "🧘🏽", colorHex: "35C878", metric: .duration, target: 15)
        let water = Habit(title: "Drink Water", note: "Eight glasses. No negotiation.", emoji: "💧", colorHex: "39C6D3", metric: .count, target: 8, unit: "glasses")
        let focus = Habit(title: "Deep Work", note: "One distraction-free block.", emoji: "🎯", colorHex: "5B5CF6", metric: .duration, target: 45)
        let sugar = Habit(title: "No Added Sugar", note: "Protect the promise you made this morning.", emoji: "🛡️", colorHex: "FF8A5B", metric: .avoid, target: 1)
        let habits = [meditate, water, focus, sugar]

        var logs: [HabitLog] = []
        let calendar = Calendar.current
        for offset in 1...8 {
            guard let day = calendar.date(byAdding: .day, value: -offset, to: Date.now) else { continue }
            let key = HabitEngine.dateKey(for: day)
            if offset != 4 { logs.append(HabitLog(habitID: meditate.id, dateKey: key, value: 15, state: .completed)) }
            logs.append(HabitLog(habitID: water.id, dateKey: key, value: Double(max(3, 9 - offset)), state: offset < 3 ? .completed : .progress))
            if offset % 3 != 0 { logs.append(HabitLog(habitID: focus.id, dateKey: key, value: 45, state: .completed)) }
            if offset != 6 { logs.append(HabitLog(habitID: sugar.id, dateKey: key, value: 1, state: .completed)) }
        }
        return HabitSnapshot(habits: habits, logs: logs)
    }
}

private extension JSONEncoder {
    static var app: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }
}

private extension JSONDecoder {
    static var app: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}
