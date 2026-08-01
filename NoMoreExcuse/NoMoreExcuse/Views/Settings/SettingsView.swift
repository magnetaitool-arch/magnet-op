import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var store: HabitStore
    @EnvironmentObject private var notifications: NotificationManager
    @State private var showingResetConfirmation = false
    private var language: AppLanguage { store.preferences.language }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 14) {
                        ZStack {
                            RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Brand.gradient)
                            Text("NME").font(.caption.weight(.black)).foregroundStyle(.white)
                        }
                        .frame(width: 58, height: 58)
                        VStack(alignment: .leading, spacing: 4) {
                            Text("No More Excuse").font(.headline)
                            Text("By Muhammed Hassan").font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 5)
                }

                Section(copy("Appearance", "المظهر", language: language)) {
                    Picker(copy("Theme", "الثيم", language: language), selection: $store.preferences.theme) {
                        Text(copy("System", "تلقائي", language: language)).tag(AppTheme.system)
                        Text(copy("Light", "فاتح", language: language)).tag(AppTheme.light)
                        Text(copy("Dark", "داكن", language: language)).tag(AppTheme.dark)
                    }
                    Picker(copy("Language", "اللغة", language: language), selection: $store.preferences.language) {
                        ForEach(AppLanguage.allCases) { item in Text(item.title).tag(item) }
                    }
                    Toggle(copy("Show streaks", "عرض أيام الاستمرار", language: language), isOn: $store.preferences.showStreaks)
                }

                Section(copy("Your day", "يومك", language: language)) {
                    Stepper(value: $store.preferences.dayStartHour, in: 0...12) {
                        LabeledContent(copy("Day starts at", "بداية اليوم", language: language), value: String(format: "%02d:00", store.preferences.dayStartHour))
                    }
                    Toggle(copy("Week starts Saturday", "الأسبوع يبدأ السبت", language: language), isOn: $store.preferences.weekStartsSaturday)
                }

                Section(copy("Feedback", "التفاعل", language: language)) {
                    Toggle(copy("Sounds", "الأصوات", language: language), isOn: $store.preferences.soundsEnabled)
                    Toggle(copy("Haptics", "الاهتزاز", language: language), isOn: $store.preferences.hapticsEnabled)
                    Toggle(copy("Notifications", "الإشعارات", language: language), isOn: Binding(
                        get: { store.preferences.notificationsEnabled },
                        set: { enabled in
                            if enabled {
                                Task {
                                    let granted = await notifications.requestAuthorization()
                                    store.preferences.notificationsEnabled = granted
                                }
                            } else {
                                store.preferences.notificationsEnabled = false
                            }
                        }
                    ))
                }

                Section(copy("Data", "البيانات", language: language)) {
                    if let data = store.exportData(), let text = String(data: data, encoding: .utf8) {
                        ShareLink(item: text) {
                            Label(copy("Export backup", "تصدير نسخة احتياطية", language: language), systemImage: "square.and.arrow.up")
                        }
                    }
                    Button { showingResetConfirmation = true } label: {
                        Label(copy("Restore demo data", "استعادة البيانات التجريبية", language: language), systemImage: "arrow.counterclockwise")
                    }
                }

                Section(copy("About", "عن التطبيق", language: language)) {
                    LabeledContent(copy("Version", "الإصدار", language: language), value: "0.1 MVP")
                    Link(destination: URL(string: "mailto:support@nomoreexcuse.app")!) {
                        Label(copy("Contact support", "تواصل مع الدعم", language: language), systemImage: "envelope")
                    }
                    Text(copy("Built to replace excuses with small, honest actions.", "اتعمل علشان نستبدل الأعذار بخطوات صغيرة وصادقة.", language: language))
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .navigationTitle(copy("Settings", "الإعدادات", language: language))
            .confirmationDialog(copy("Restore demo data?", "استعادة البيانات التجريبية؟", language: language), isPresented: $showingResetConfirmation) {
                Button(copy("Restore", "استعادة", language: language), role: .destructive) { store.resetDemoData() }
                Button(copy("Cancel", "إلغاء", language: language), role: .cancel) { }
            } message: {
                Text(copy("This replaces your current local habits and logs.", "ده هيستبدل العادات والسجلات الموجودة على الجهاز.", language: language))
            }
        }
    }
}
