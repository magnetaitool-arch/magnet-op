import SwiftUI

struct RootTabView: View {
    @EnvironmentObject private var store: HabitStore
    @State private var selection = 0

    private var language: AppLanguage { store.preferences.language }

    var body: some View {
        TabView(selection: $selection) {
            TodayView()
                .tabItem { Label(copy("Today", "اليوم", language: language), systemImage: "checklist") }
                .tag(0)

            InsightsView()
                .tabItem { Label(copy("Insights", "الإحصائيات", language: language), systemImage: "chart.bar.fill") }
                .tag(1)

            CircleView()
                .tabItem { Label(copy("Circle", "الدائرة", language: language), systemImage: "person.3.fill") }
                .tag(2)

            SettingsView()
                .tabItem { Label(copy("Settings", "الإعدادات", language: language), systemImage: "gearshape.fill") }
                .tag(3)
        }
        .toolbarBackground(.ultraThinMaterial, for: .tabBar)
        .toolbarBackground(.visible, for: .tabBar)
    }
}
