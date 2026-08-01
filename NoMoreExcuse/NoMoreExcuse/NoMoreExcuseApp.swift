import SwiftUI

@main
struct NoMoreExcuseApp: App {
    @StateObject private var store = HabitStore()
    @StateObject private var notifications = NotificationManager()

    var body: some Scene {
        WindowGroup {
            Group {
                if store.preferences.hasCompletedOnboarding {
                    RootTabView()
                } else {
                    OnboardingView()
                }
            }
                .animation(.easeInOut(duration: 0.35), value: store.preferences.hasCompletedOnboarding)
                .environmentObject(store)
                .environmentObject(notifications)
                .preferredColorScheme(store.preferences.theme.colorScheme)
                .environment(\.layoutDirection, store.preferences.language == .arabic ? .rightToLeft : .leftToRight)
                .tint(Brand.primary)
        }
    }
}
