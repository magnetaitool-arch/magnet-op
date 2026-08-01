import SwiftUI
import NoMoreExcuseCore

struct InsightsView: View {
    @EnvironmentObject private var store: HabitStore
    private var language: AppLanguage { store.preferences.language }
    private var dates: [Date] { HabitEngine.lastDates(count: 7, through: .now) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    weeklyScoreCard
                    consistencyChart
                    heatmapCard
                    streakCard
                }
                .padding(16)
                .padding(.bottom, 24)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle(copy("Insights", "الإحصائيات", language: language))
        }
    }

    private var weeklyScoreCard: some View {
        let average = dates.map { store.dailyScore(on: $0) }.reduce(0, +) / Double(max(1, dates.count))
        return HStack(spacing: 18) {
            ZStack {
                ProgressRing(progress: average, lineWidth: 11, color: Brand.secondary, size: 92)
                Text("\(Int(average * 100))%")
                    .font(.headline.weight(.black))
            }
            VStack(alignment: .leading, spacing: 7) {
                Text(copy("Weekly consistency", "الالتزام الأسبوعي", language: language))
                    .font(.headline)
                Text(average >= 0.75
                     ? copy("Your system is working. Protect it.", "نظامك شغال. حافظ عليه.", language: language)
                     : copy("Make the next habit smaller, not optional.", "صغّر العادة الجاية، لكن متلغيهاش.", language: language))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(20)
        .brandCard()
    }

    private var consistencyChart: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Text(copy("Last 7 days", "آخر ٧ أيام", language: language)).font(.headline)
                Spacer()
                Text(copy("Daily score", "نتيجة اليوم", language: language)).font(.caption).foregroundStyle(.secondary)
            }
            HStack(alignment: .bottom, spacing: 10) {
                ForEach(dates, id: \.self) { date in
                    let value = store.dailyScore(on: date)
                    VStack(spacing: 8) {
                        Text("\(Int(value * 100))")
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(.secondary)
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(value == 1 ? Brand.secondary : Brand.primary.opacity(0.82))
                            .frame(height: max(8, 128 * value))
                        Text(date.formatted(.dateTime.weekday(.narrow)))
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                }
            }
            .frame(height: 174, alignment: .bottom)
        }
        .padding(20)
        .brandCard()
    }

    private var heatmapCard: some View {
        let month = HabitEngine.lastDates(count: 35, through: .now)
        let columns = Array(repeating: GridItem(.flexible(), spacing: 7), count: 7)
        return VStack(alignment: .leading, spacing: 16) {
            Text(copy("Momentum map", "خريطة الاستمرار", language: language)).font(.headline)
            LazyVGrid(columns: columns, spacing: 7) {
                ForEach(month, id: \.self) { date in
                    let score = store.dailyScore(on: date)
                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                        .fill(heatColor(score))
                        .aspectRatio(1, contentMode: .fit)
                        .overlay {
                            Text(date.formatted(.dateTime.day()))
                                .font(.system(size: 8, weight: .bold))
                                .foregroundStyle(score > 0.55 ? .white : .secondary)
                        }
                        .accessibilityLabel("\(date.formatted(date: .abbreviated, time: .omitted)), \(Int(score * 100)) percent")
                }
            }
            HStack(spacing: 8) {
                Text(copy("Less", "أقل", language: language)).font(.caption2).foregroundStyle(.secondary)
                ForEach([0.1, 0.35, 0.65, 1.0], id: \.self) { score in
                    RoundedRectangle(cornerRadius: 3).fill(heatColor(score)).frame(width: 18, height: 10)
                }
                Text(copy("More", "أكثر", language: language)).font(.caption2).foregroundStyle(.secondary)
            }
        }
        .padding(20)
        .brandCard()
    }

    private var streakCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(copy("Strongest promises", "أقوى عاداتك", language: language)).font(.headline)
            ForEach(store.activeHabits.sorted { store.streak(for: $0) > store.streak(for: $1) }.prefix(4)) { habit in
                HStack(spacing: 12) {
                    Text(habit.emoji).font(.title2)
                    Text(habit.title).font(.subheadline.weight(.semibold))
                    Spacer()
                    Label("\(store.streak(for: habit))", systemImage: "flame.fill")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(Brand.accent)
                }
                if habit.id != store.activeHabits.last?.id { Divider() }
            }
        }
        .padding(20)
        .brandCard()
    }

    private func heatColor(_ score: Double) -> Color {
        switch score {
        case 0.85...: return Brand.primary
        case 0.55...: return Brand.primary.opacity(0.68)
        case 0.2...: return Brand.primary.opacity(0.35)
        case 0.001...: return Brand.primary.opacity(0.18)
        default: return Color.primary.opacity(0.06)
        }
    }
}
