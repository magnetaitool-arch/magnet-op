import SwiftUI

struct CircleView: View {
    @EnvironmentObject private var store: HabitStore
    @State private var checkInDone = false
    private var language: AppLanguage { store.preferences.language }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    hero
                    checkInCard
                    challengeCard
                    privacyCard
                }
                .padding(16)
                .padding(.bottom, 24)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle(copy("Accountability", "دائرة الالتزام", language: language))
        }
    }

    private var hero: some View {
        VStack(spacing: 16) {
            ZStack {
                Circle().fill(Brand.primary.opacity(0.12)).frame(width: 112, height: 112)
                Image(systemName: "person.3.fill").font(.system(size: 42)).foregroundStyle(Brand.primary)
            }
            Text(copy("Do it together", "الالتزام أسهل مع حد", language: language))
                .font(.title2.weight(.bold))
            Text(copy("Invite one trusted person. Share progress—not private notes or health data.", "اعزم شخص تثق فيه. شارك التقدم فقط، من غير ملاحظاتك الخاصة أو بياناتك الصحية.", language: language))
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            ShareLink(item: inviteText) {
                Label(copy("Invite accountability partner", "اعزم شريك التزام", language: language), systemImage: "square.and.arrow.up")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        }
        .padding(24)
        .brandCard()
    }

    private var checkInCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text(copy("Daily check-in", "تسجيل الحضور اليومي", language: language)).font(.headline)
                    Text(copy("One tap. Honest signal.", "ضغطة واحدة. إشارة صادقة.", language: language)).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Text("\(Int(store.dailyScore() * 100))%")
                    .font(.title2.weight(.black)).foregroundStyle(Brand.primary)
            }
            Button {
                withAnimation(.spring) { checkInDone.toggle() }
            } label: {
                Label(
                    checkInDone ? copy("Check-in shared", "تمت مشاركة الحضور", language: language) : copy("Share today's score", "شارك نتيجة اليوم", language: language),
                    systemImage: checkInDone ? "checkmark.circle.fill" : "paperplane.fill"
                )
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
        }
        .padding(20)
        .brandCard()
    }

    private var challengeCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label(copy("7-day no-zero challenge", "تحدي ٧ أيام بدون صفر", language: language), systemImage: "bolt.fill")
                .font(.headline).foregroundStyle(Brand.accent)
            Text(copy("Complete at least one meaningful habit every day. A small win protects identity.", "كمّل عادة مهمة واحدة على الأقل كل يوم. الفوز الصغير بيحمي هويتك الجديدة.", language: language))
                .font(.subheadline).foregroundStyle(.secondary)
            HStack(spacing: 8) {
                ForEach(0..<7, id: \.self) { index in
                    Circle()
                        .fill(index < 3 ? Brand.secondary : Color.primary.opacity(0.08))
                        .overlay { if index < 3 { Image(systemName: "checkmark").font(.caption2.bold()).foregroundStyle(.white) } }
                        .frame(maxWidth: .infinity)
                        .aspectRatio(1, contentMode: .fit)
                }
            }
        }
        .padding(20)
        .brandCard()
    }

    private var privacyCard: some View {
        Label {
            Text(copy("Partner sync is presented as a local preview in this MVP. Secure account-based sharing comes with the cloud phase.", "المشاركة هنا معاينة محلية في النسخة الأولى. الربط الآمن بالحسابات هيكون في مرحلة الكلاود.", language: language))
                .font(.caption).foregroundStyle(.secondary)
        } icon: {
            Image(systemName: "lock.shield.fill").foregroundStyle(Brand.secondary)
        }
        .padding(18)
        .brandCard()
    }

    private var inviteText: String {
        copy(
            "Join my No More Excuse accountability circle. One honest action every day. — Muhammed Hassan",
            "انضم لدائرة الالتزام بتاعتي على No More Excuse. خطوة صادقة كل يوم. — Muhammed Hassan",
            language: language
        )
    }
}
