import SwiftUI

enum AppLanguage: String, Codable, CaseIterable, Identifiable {
    case english
    case arabic

    var id: String { rawValue }
    var title: String { self == .arabic ? "العربية" : "English" }
}

enum AppTheme: String, Codable, CaseIterable, Identifiable {
    case system
    case light
    case dark

    var id: String { rawValue }
    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }
}

struct AppPreferences: Codable, Equatable {
    var hasCompletedOnboarding = false
    var language: AppLanguage = .english
    var theme: AppTheme = .system
    var weekStartsSaturday = true
    var soundsEnabled = true
    var hapticsEnabled = true
    var notificationsEnabled = false
    var dayStartHour = 4
    var showStreaks = true
}

func copy(_ english: String, _ arabic: String, language: AppLanguage) -> String {
    language == .arabic ? arabic : english
}
