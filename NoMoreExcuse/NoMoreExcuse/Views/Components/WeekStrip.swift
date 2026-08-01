import SwiftUI
import NoMoreExcuseCore

struct WeekStrip: View {
    @Binding var selectedDate: Date
    let language: AppLanguage
    var firstWeekday: Int = 7

    private var dates: [Date] { HabitEngine.weekDates(containing: selectedDate, firstWeekday: firstWeekday) }
    private let calendar = Calendar.current

    var body: some View {
        HStack(spacing: 8) {
            ForEach(dates, id: \.self) { date in
                let selected = calendar.isDate(date, inSameDayAs: selectedDate)
                Button {
                    withAnimation(.spring(response: 0.35, dampingFraction: 0.78)) {
                        selectedDate = date
                    }
                } label: {
                    VStack(spacing: 8) {
                        Text(dayName(date))
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(selected ? .white.opacity(0.85) : .secondary)
                        Text(date.formatted(.dateTime.day()))
                            .font(.body.weight(.bold))
                            .foregroundStyle(selected ? .white : .primary)
                            .frame(width: 36, height: 36)
                            .background(selected ? .white.opacity(0.18) : Color.primary.opacity(0.055), in: Circle())
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .background(selected ? Brand.gradient : LinearGradient(colors: [.clear], startPoint: .top, endPoint: .bottom), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(date.formatted(date: .complete, time: .omitted))
            }
        }
    }

    private func dayName(_ date: Date) -> String {
        let index = calendar.component(.weekday, from: date) - 1
        let english = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]
        let arabic = ["أحد", "إثن", "ثلا", "أرب", "خمي", "جمع", "سبت"]
        return language == .arabic ? arabic[index] : english[index]
    }
}
