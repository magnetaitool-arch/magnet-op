import SwiftUI
import NoMoreExcuseCore

struct HabitTimerView: View {
    @EnvironmentObject private var store: HabitStore
    @Environment(\.dismiss) private var dismiss
    let habit: Habit

    @State private var elapsed = 0
    @State private var committed = 0
    @State private var isRunning = false
    private let ticker = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    private var language: AppLanguage { store.preferences.language }
    private var targetSeconds: Int { max(60, Int(habit.target * 60)) }
    private var progress: Double { min(Double(elapsed) / Double(targetSeconds), 1) }

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                Spacer()
                Text(habit.emoji).font(.system(size: 54))
                VStack(spacing: 7) {
                    Text(habit.title).font(.title.bold())
                    Text(habit.note).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                }

                ZStack {
                    ProgressRing(progress: progress, lineWidth: 16, color: Color(hex: habit.colorHex), size: 252)
                    VStack(spacing: 6) {
                        Text(timeText)
                            .font(.system(size: 54, weight: .black, design: .rounded))
                            .monospacedDigit()
                        Text("/ \(Int(habit.target)) \(copy("min", "دقيقة", language: language))")
                            .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    }
                }

                Text(copy("Stay here. The urge to quit is just a moment passing.", "خليك هنا. رغبة التوقف مجرد لحظة وهتعدّي.", language: language))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 30)

                HStack(spacing: 16) {
                    Button {
                        commitProgress()
                        dismiss()
                    } label: {
                        Label(copy("Finish", "إنهاء", language: language), systemImage: "checkmark")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)

                    Button {
                        isRunning.toggle()
                    } label: {
                        Label(isRunning ? copy("Pause", "إيقاف", language: language) : copy("Start", "ابدأ", language: language), systemImage: isRunning ? "pause.fill" : "play.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                }
                .controlSize(.large)
                .padding(.horizontal, 24)
                Spacer()
            }
            .navigationTitle(copy("Focus timer", "مؤقت التركيز", language: language))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button(copy("Close", "إغلاق", language: language)) { commitProgress(); dismiss() } } }
            .onReceive(ticker) { _ in
                guard isRunning else { return }
                elapsed += 1
                if elapsed >= targetSeconds { isRunning = false; commitProgress() }
            }
            .onDisappear { commitProgress() }
        }
    }

    private var timeText: String {
        String(format: "%02d:%02d", elapsed / 60, elapsed % 60)
    }

    private func commitProgress() {
        let delta = elapsed - committed
        guard delta > 0 else { return }
        store.addDuration(delta, to: habit)
        committed = elapsed
    }
}
