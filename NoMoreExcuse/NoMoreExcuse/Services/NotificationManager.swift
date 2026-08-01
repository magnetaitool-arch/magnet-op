import Foundation
import UserNotifications
import NoMoreExcuseCore

@MainActor
final class NotificationManager: ObservableObject {
    @Published private(set) var authorization: UNAuthorizationStatus = .notDetermined

    init() {
        Task { await refreshAuthorization() }
    }

    func requestAuthorization() async -> Bool {
        do {
            let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
            await refreshAuthorization()
            return granted
        } catch {
            await refreshAuthorization()
            return false
        }
    }

    func scheduleReminder(for habit: Habit) async {
        guard let hour = habit.reminderHour, let minute = habit.reminderMinute else { return }
        let center = UNUserNotificationCenter.current()
        let identifiers = [habit.id.uuidString] + (1...7).map { "\(habit.id.uuidString)-\($0)" }
        center.removePendingNotificationRequests(withIdentifiers: identifiers)

        let content = UNMutableNotificationContent()
        content.title = "No More Excuse"
        content.body = "\(habit.emoji) \(habit.title) — your next action is waiting."
        content.sound = .default

        if habit.schedule.weekdays.isEmpty {
            let components = DateComponents(hour: hour, minute: minute)
            let trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: true)
            try? await center.add(UNNotificationRequest(identifier: habit.id.uuidString, content: content, trigger: trigger))
        } else {
            for weekday in habit.schedule.weekdays {
                let components = DateComponents(weekday: weekday, hour: hour, minute: minute)
                let trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: true)
                try? await center.add(UNNotificationRequest(identifier: "\(habit.id.uuidString)-\(weekday)", content: content, trigger: trigger))
            }
        }
    }

    func cancelReminder(for habitID: UUID) {
        let identifiers = [habitID.uuidString] + (1...7).map { "\(habitID.uuidString)-\($0)" }
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: identifiers)
    }

    private func refreshAuthorization() async {
        authorization = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }
}
