import SwiftUI
import NoMoreExcuseCore

struct TodayView: View {
    @EnvironmentObject private var store: HabitStore
    @State private var showingEditor = false
    @State private var editingHabit: Habit?
    @State private var timerHabit: Habit?

    private var language: AppLanguage { store.preferences.language }
    private var due: [Habit] { store.scheduledHabits(on: store.selectedDate) }
    private var score: Double { store.dailyScore() }

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(spacing: 16) {
                    identityHeader
                    WeekStrip(selectedDate: $store.selectedDate, language: language, firstWeekday: store.preferences.weekStartsSaturday ? 7 : 1)
                        .padding(8)
                        .background(.background, in: RoundedRectangle(cornerRadius: 26, style: .continuous))

                    scoreCard

                    if due.isEmpty {
                        emptyState
                    } else {
                        ForEach(due) { habit in
                            HabitCard(
                                habit: habit,
                                progress: store.progress(for: habit),
                                currentValue: store.log(for: habit)?.value ?? 0,
                                streak: store.preferences.showStreaks ? store.streak(for: habit) : 0,
                                isComplete: store.isComplete(habit),
                                language: language,
                                onAction: { primaryAction(for: habit) },
                                onTimer: { timerHabit = habit },
                                onEdit: { editingHabit = habit }
                            )
                        }
                    }

                    Text("NO MORE EXCUSE · BY MUHAMMED HASSAN")
                        .font(.caption2.weight(.bold))
                        .tracking(1.6)
                        .foregroundStyle(.tertiary)
                        .padding(.vertical, 20)
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showingEditor = true } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 17, weight: .bold))
                            .foregroundStyle(.white)
                            .frame(width: 40, height: 40)
                            .background(Brand.gradient, in: Circle())
                    }
                    .accessibilityLabel(copy("Add habit", "إضافة عادة", language: language))
                }
            }
            .sheet(isPresented: $showingEditor) { HabitEditorView() }
            .sheet(item: $editingHabit) { HabitEditorView(existing: $0) }
            .sheet(item: $timerHabit) { HabitTimerView(habit: $0) }
        }
    }

    private var identityHeader: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 3) {
                Text("NO MORE EXCUSE")
                    .font(.title2.weight(.black))
                    .tracking(-0.5)
                Text(dateTitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            ZStack {
                Circle().fill(Brand.gradient)
                Text("MH").font(.caption.weight(.black)).foregroundStyle(.white)
            }
            .frame(width: 42, height: 42)
        }
        .padding(.top, 8)
    }

    private var scoreCard: some View {
        HStack(spacing: 18) {
            ZStack {
                ProgressRing(progress: score, lineWidth: 10, color: Brand.primary, size: 86)
                Text("\(Int(score * 100))")
                    .font(.title3.weight(.black))
            }
            VStack(alignment: .leading, spacing: 6) {
                Text(scoreHeadline)
                    .font(.title3.weight(.bold))
                Text(scoreMessage)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(20)
        .background(
            LinearGradient(colors: [Brand.primary.opacity(0.14), Brand.secondary.opacity(0.08)], startPoint: .topLeading, endPoint: .bottomTrailing),
            in: RoundedRectangle(cornerRadius: 26, style: .continuous)
        )
        .overlay(alignment: .topTrailing) {
            Text(copy("DAILY SCORE", "نتيجة اليوم", language: language))
                .font(.caption2.weight(.bold))
                .tracking(1.2)
                .foregroundStyle(Brand.primary)
                .padding(14)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 14) {
            Image(systemName: "sparkles")
                .font(.system(size: 38))
                .foregroundStyle(Brand.primary)
            Text(copy("A clean day", "يوم هادي", language: language)).font(.headline)
            Text(copy("No habits are scheduled. Rest, review, or add one small promise.", "مفيش عادات مجدولة. ارتاح أو أضف وعد صغير لنفسك.", language: language))
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button(copy("Add a habit", "أضف عادة", language: language)) { showingEditor = true }
                .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity)
        .padding(32)
        .brandCard()
    }

    private var dateTitle: String {
        if Calendar.current.isDateInToday(store.selectedDate) { return copy("Today", "اليوم", language: language) }
        return store.selectedDate.formatted(.dateTime.weekday(.wide).month(.wide).day())
    }

    private var scoreHeadline: String {
        switch score {
        case 1: return copy("Promises kept.", "وفيت بكل وعودك.", language: language)
        case 0.65...: return copy("Finish strong.", "كمّلها للآخر.", language: language)
        case 0.01...: return copy("Momentum started.", "بدأت الحركة.", language: language)
        default: return copy("One action. Now.", "خطوة واحدة. دلوقتي.", language: language)
        }
    }

    private var scoreMessage: String {
        score == 1
            ? copy("You showed up. Bank the win and recover.", "حضرت لنفسك. احتفل بالإنجاز وخد راحتك.", language: language)
            : copy("You do not need motivation—only the next honest action.", "مش محتاج دافع؛ محتاج الخطوة الصادقة الجاية.", language: language)
    }

    private func primaryAction(for habit: Habit) {
        switch habit.metric {
        case .count: store.increment(habit)
        case .duration: timerHabit = habit
        case .check, .avoid: store.toggle(habit)
        }
    }
}
