import SwiftUI
import NoMoreExcuseCore

struct HabitEditorView: View {
    @EnvironmentObject private var store: HabitStore
    @EnvironmentObject private var notifications: NotificationManager
    @Environment(\.dismiss) private var dismiss

    private let existing: Habit?
    @State private var title: String
    @State private var note: String
    @State private var emoji: String
    @State private var colorHex: String
    @State private var metric: HabitMetric
    @State private var target: Double
    @State private var selectedWeekdays: Set<Int>
    @State private var reminderEnabled: Bool
    @State private var reminderTime: Date

    private let colors = ["5B5CF6", "16C79A", "35C878", "39C6D3", "FF8A5B", "E24EC9", "FFC857"]
    private let emojis = ["⚡️", "🧘🏽", "💧", "🎯", "📚", "🏃🏽", "🛡️", "🛏️", "🥗", "✍🏽"]
    private var language: AppLanguage { store.preferences.language }

    init(existing: Habit? = nil) {
        self.existing = existing
        _title = State(initialValue: existing?.title ?? "")
        _note = State(initialValue: existing?.note ?? "")
        _emoji = State(initialValue: existing?.emoji ?? "⚡️")
        _colorHex = State(initialValue: existing?.colorHex ?? "5B5CF6")
        _metric = State(initialValue: existing?.metric ?? .check)
        _target = State(initialValue: existing?.target ?? 1)
        _selectedWeekdays = State(initialValue: Set(existing?.schedule.weekdays ?? []))
        _reminderEnabled = State(initialValue: existing?.reminderHour != nil)
        let comps = DateComponents(hour: existing?.reminderHour ?? 20, minute: existing?.reminderMinute ?? 0)
        _reminderTime = State(initialValue: Calendar.current.date(from: comps) ?? .now)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section(copy("Identity", "الهوية", language: language)) {
                    TextField(copy("Habit name", "اسم العادة", language: language), text: $title)
                    TextField(copy("Why does it matter?", "ليه العادة دي مهمة؟", language: language), text: $note, axis: .vertical)
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack {
                            ForEach(emojis, id: \.self) { item in
                                Button { emoji = item } label: {
                                    Text(item).font(.title2).padding(8)
                                        .background(emoji == item ? Brand.primary.opacity(0.16) : .clear, in: RoundedRectangle(cornerRadius: 12))
                                }.buttonStyle(.plain)
                            }
                        }
                    }
                    HStack {
                        ForEach(colors, id: \.self) { item in
                            Button { colorHex = item } label: {
                                Circle().fill(Color(hex: item)).frame(width: 28, height: 28)
                                    .overlay { if colorHex == item { Image(systemName: "checkmark").font(.caption.bold()).foregroundStyle(.white) } }
                            }.buttonStyle(.plain)
                        }
                    }
                }

                Section(copy("Goal", "الهدف", language: language)) {
                    Picker(copy("Track as", "نوع القياس", language: language), selection: $metric) {
                        Text(copy("Done / not done", "تم / لم يتم", language: language)).tag(HabitMetric.check)
                        Text(copy("Count", "عدد", language: language)).tag(HabitMetric.count)
                        Text(copy("Timer", "وقت", language: language)).tag(HabitMetric.duration)
                        Text(copy("Avoid", "تجنب", language: language)).tag(HabitMetric.avoid)
                    }
                    if metric == .count || metric == .duration {
                        Stepper(value: $target, in: 1...600, step: 1) {
                            Text("\(Int(target)) \(metric == .duration ? copy("minutes", "دقيقة", language: language) : copy("times", "مرة", language: language))")
                        }
                    }
                }

                Section(copy("Repeat", "التكرار", language: language)) {
                    HStack(spacing: 7) {
                        ForEach(1...7, id: \.self) { weekday in
                            let selected = selectedWeekdays.contains(weekday)
                            Button {
                                if selected { selectedWeekdays.remove(weekday) } else { selectedWeekdays.insert(weekday) }
                            } label: {
                                Text(shortDay(weekday))
                                    .font(.caption2.bold())
                                    .frame(maxWidth: .infinity, minHeight: 34)
                                    .foregroundStyle(selected ? .white : .primary)
                                    .background(selected ? Brand.primary : Color.primary.opacity(0.06), in: Circle())
                            }.buttonStyle(.plain)
                        }
                    }
                    Text(selectedWeekdays.isEmpty ? copy("Every day", "كل يوم", language: language) : copy("Selected days", "الأيام المختارة", language: language))
                        .font(.caption).foregroundStyle(.secondary)
                }

                Section(copy("Reminder", "التذكير", language: language)) {
                    Toggle(copy("Daily reminder", "تذكير يومي", language: language), isOn: $reminderEnabled)
                    if reminderEnabled {
                        DatePicker(copy("Time", "الوقت", language: language), selection: $reminderTime, displayedComponents: .hourAndMinute)
                    }
                }
            }
            .navigationTitle(existing == nil ? copy("New promise", "وعد جديد", language: language) : copy("Edit habit", "تعديل العادة", language: language))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(copy("Cancel", "إلغاء", language: language)) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button(copy("Save", "حفظ", language: language), action: save).disabled(title.trimmingCharacters(in: .whitespaces).isEmpty) }
            }
        }
    }

    private func save() {
        var habit = existing ?? Habit(title: title)
        habit.title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        habit.note = note.trimmingCharacters(in: .whitespacesAndNewlines)
        habit.emoji = emoji
        habit.colorHex = colorHex
        habit.metric = metric
        habit.target = metric == .check || metric == .avoid ? 1 : target
        habit.unit = metric.defaultUnit
        habit.schedule = HabitSchedule(weekdays: Array(selectedWeekdays))
        if reminderEnabled {
            let values = Calendar.current.dateComponents([.hour, .minute], from: reminderTime)
            habit.reminderHour = values.hour
            habit.reminderMinute = values.minute
        } else {
            habit.reminderHour = nil
            habit.reminderMinute = nil
        }
        if existing == nil { store.add(habit) } else { store.update(habit) }
        if reminderEnabled {
            Task { await notifications.scheduleReminder(for: habit) }
        } else {
            notifications.cancelReminder(for: habit.id)
        }
        dismiss()
    }

    private func shortDay(_ weekday: Int) -> String {
        let en = ["S", "M", "T", "W", "T", "F", "S"]
        let ar = ["ح", "ن", "ث", "ر", "خ", "ج", "س"]
        return language == .arabic ? ar[weekday - 1] : en[weekday - 1]
    }
}
