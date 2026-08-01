import SwiftUI
import NoMoreExcuseCore

struct HabitCard: View {
    let habit: Habit
    let progress: Double
    let currentValue: Double
    let streak: Int
    let isComplete: Bool
    let language: AppLanguage
    let onAction: () -> Void
    let onTimer: () -> Void
    let onEdit: () -> Void

    private var tint: Color { Color(hex: habit.colorHex) }

    var body: some View {
        HStack(spacing: 14) {
            Text(habit.emoji)
                .font(.system(size: 30))
                .frame(width: 52, height: 52)
                .background(tint.opacity(0.13), in: RoundedRectangle(cornerRadius: 17, style: .continuous))

            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 7) {
                    Text(habit.title)
                        .font(.headline)
                        .lineLimit(1)
                    if streak > 1 {
                        Label("\(streak)", systemImage: "flame.fill")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(Brand.accent)
                    }
                }

                Text(progressText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)

                GeometryReader { geometry in
                    Capsule()
                        .fill(tint.opacity(0.12))
                        .overlay(alignment: .leading) {
                            Capsule()
                                .fill(tint)
                                .frame(width: geometry.size.width * progress)
                        }
                }
                .frame(height: 6)
            }

            Button(action: habit.metric == .duration ? onTimer : onAction) {
                ZStack {
                    ProgressRing(progress: progress, lineWidth: 6, color: tint, size: 54)
                    Image(systemName: actionIcon)
                        .font(.system(size: 17, weight: .bold))
                        .foregroundStyle(isComplete ? .white : tint)
                        .frame(width: 38, height: 38)
                        .background(isComplete ? tint : tint.opacity(0.1), in: Circle())
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel(actionLabel)
        }
        .padding(16)
        .brandCard()
        .contextMenu {
            Button(action: onEdit) { Label(copy("Edit", "تعديل", language: language), systemImage: "pencil") }
            Button(action: onAction) { Label(copy("Toggle complete", "تغيير حالة الإنجاز", language: language), systemImage: "checkmark.circle") }
        }
    }

    private var progressText: String {
        if isComplete { return copy("Done — promise kept", "تم — وفيت بوعدك", language: language) }
        switch habit.metric {
        case .check, .avoid:
            return habit.note.isEmpty ? copy("Tap when complete", "اضغط عند الإنجاز", language: language) : habit.note
        case .count:
            return "\(Int(currentValue))/\(Int(habit.target)) \(habit.unit)"
        case .duration:
            return "\(Int(currentValue))/\(Int(habit.target)) \(copy("minutes", "دقيقة", language: language))"
        }
    }

    private var actionIcon: String {
        if isComplete { return "checkmark" }
        switch habit.metric {
        case .duration: return "play.fill"
        case .count: return "plus"
        case .check, .avoid: return "checkmark"
        }
    }

    private var actionLabel: String {
        if habit.metric == .duration { return copy("Start timer", "ابدأ المؤقت", language: language) }
        return copy("Record progress", "سجل التقدم", language: language)
    }
}
