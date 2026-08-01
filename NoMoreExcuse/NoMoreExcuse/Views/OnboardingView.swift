import SwiftUI
import NoMoreExcuseCore

struct OnboardingView: View {
    @EnvironmentObject private var store: HabitStore
    @State private var page = 0
    @State private var selectedStarter = 0

    private var language: AppLanguage { store.preferences.language }
    private var starters: [Habit] {
        [
            Habit(title: copy("Meditate", "تأمل", language: language), note: copy("Five quiet minutes before the noise.", "خمس دقايق هدوء قبل الزحمة.", language: language), emoji: "🧘🏽", colorHex: "35C878", metric: .duration, target: 5),
            Habit(title: copy("Move", "اتحرك", language: language), note: copy("Twenty minutes for your future body.", "عشرين دقيقة لجسمك المستقبلي.", language: language), emoji: "🏃🏽", colorHex: "FF8A5B", metric: .duration, target: 20),
            Habit(title: copy("Read", "اقرأ", language: language), note: copy("Ten pages. Phone away.", "عشر صفحات. الموبايل بعيد.", language: language), emoji: "📚", colorHex: "5B5CF6", metric: .count, target: 10, unit: "pages"),
            Habit(title: copy("No added sugar", "بدون سكر مضاف", language: language), note: copy("Win one clean day.", "اكسب يوم نضيف واحد.", language: language), emoji: "🛡️", colorHex: "FFC857", metric: .avoid)
        ]
    }

    var body: some View {
        ZStack {
            Color(uiColor: .systemBackground).ignoresSafeArea()
            VStack(spacing: 0) {
                HStack {
                    Text("BY MUHAMMED HASSAN")
                        .font(.caption2.weight(.bold)).tracking(1.4).foregroundStyle(.secondary)
                    Spacer()
                    Button(language == .arabic ? "EN" : "ع") {
                        store.preferences.language = language == .arabic ? .english : .arabic
                    }
                    .font(.caption.weight(.bold))
                    .buttonStyle(.bordered)
                }
                .padding(.horizontal, 24)
                .padding(.top, 14)

                TabView(selection: $page) {
                    intro.tag(0)
                    systemPage.tag(1)
                    starterPage.tag(2)
                }
                .tabViewStyle(.page(indexDisplayMode: .never))

                HStack(spacing: 8) {
                    ForEach(0..<3, id: \.self) { index in
                        Capsule()
                            .fill(index == page ? Brand.primary : Color.primary.opacity(0.12))
                            .frame(width: index == page ? 28 : 8, height: 8)
                            .animation(.spring, value: page)
                    }
                }
                .padding(.bottom, 22)

                Button(action: next) {
                    Text(page == 2 ? copy("Start with no excuses", "ابدأ من غير أعذار", language: language) : copy("Continue", "كمّل", language: language))
                        .font(.headline)
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 16)
                        .background(Brand.gradient, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                }
                .padding(.horizontal, 24)
                .padding(.bottom, 18)
            }
        }
    }

    private var intro: some View {
        VStack(spacing: 22) {
            Spacer()
            ZStack {
                RoundedRectangle(cornerRadius: 34, style: .continuous).fill(Brand.gradient)
                    .frame(width: 138, height: 138)
                    .rotationEffect(.degrees(-5))
                Image(systemName: "checkmark").font(.system(size: 66, weight: .black)).foregroundStyle(.white)
            }
            Text("NO MORE\nEXCUSE")
                .font(.system(size: 44, weight: .black, design: .rounded))
                .multilineTextAlignment(.center)
                .tracking(-1.5)
            Text(copy("Motivation changes. Your system should not.", "الدافع بيتغيّر. نظامك لازم يفضل ثابت.", language: language))
                .font(.title3.weight(.medium))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 30)
            Spacer()
        }
    }

    private var systemPage: some View {
        VStack(alignment: .leading, spacing: 22) {
            Spacer()
            Text(copy("A system that respects real life", "نظام بيحترم حياتك الحقيقية", language: language))
                .font(.largeTitle.weight(.black))
            feature("bolt.fill", copy("Tiny actions", "خطوات صغيرة", language: language), copy("Make the next step obvious and easy to start.", "خلّي الخطوة الجاية واضحة وسهلة تبدأها.", language: language), Brand.gold)
            feature("chart.xyaxis.line", copy("Honest insights", "إحصائيات صادقة", language: language), copy("See consistency without shame or fake perfection.", "شوف التزامك من غير جلد ذات أو كمال مزيف.", language: language), Brand.primary)
            feature("person.2.fill", copy("Accountability", "شريك التزام", language: language), copy("Share progress with people you trust.", "شارك تقدمك مع ناس تثق فيهم.", language: language), Brand.secondary)
            feature("lock.shield.fill", copy("Private by default", "خاص من البداية", language: language), copy("Your habits stay on your device in this MVP.", "عاداتك محفوظة على جهازك في النسخة الأولى.", language: language), Brand.accent)
            Spacer()
        }
        .padding(.horizontal, 26)
    }

    private var starterPage: some View {
        VStack(alignment: .leading, spacing: 16) {
            Spacer()
            Text(copy("Choose one promise", "اختار وعد واحد", language: language))
                .font(.largeTitle.weight(.black))
            Text(copy("You can add more later. Start with the action that changes tonight.", "تقدر تزود بعدين. ابدأ بالفعل اللي هيغيّر النهارده.", language: language))
                .font(.subheadline).foregroundStyle(.secondary)

            ForEach(Array(starters.enumerated()), id: \.offset) { index, habit in
                Button {
                    selectedStarter = index
                } label: {
                    HStack(spacing: 14) {
                        Text(habit.emoji).font(.title2)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(habit.title).font(.headline).foregroundStyle(.primary)
                            Text(habit.note).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer()
                        Image(systemName: selectedStarter == index ? "checkmark.circle.fill" : "circle")
                            .font(.title3).foregroundStyle(selectedStarter == index ? Brand.primary : .secondary)
                    }
                    .padding(16)
                    .background(selectedStarter == index ? Brand.primary.opacity(0.1) : Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 19, style: .continuous))
                }
                .buttonStyle(.plain)
            }
            Spacer()
        }
        .padding(.horizontal, 24)
    }

    private func feature(_ icon: String, _ title: String, _ subtitle: String, _ color: Color) -> some View {
        HStack(spacing: 15) {
            Image(systemName: icon).font(.title3).foregroundStyle(color)
                .frame(width: 48, height: 48).background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 15))
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.headline)
                Text(subtitle).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func next() {
        if page < 2 {
            withAnimation { page += 1 }
        } else {
            store.startFresh(with: starters[selectedStarter])
        }
    }
}
