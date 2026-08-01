import SwiftUI

enum Brand {
    static let primary = Color(hex: "5B5CF6")
    static let secondary = Color(hex: "16C79A")
    static let accent = Color(hex: "FF6B5F")
    static let gold = Color(hex: "FFC857")
    static let canvas = Color(hex: "F5F6FA")
    static let ink = Color(hex: "161821")

    static let gradient = LinearGradient(
        colors: [Color(hex: "5B5CF6"), Color(hex: "8B5CF6")],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )
}

extension Color {
    init(hex: String) {
        let clean = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        var value: UInt64 = 0
        Scanner(string: clean).scanHexInt64(&value)
        let red, green, blue, alpha: UInt64
        switch clean.count {
        case 8:
            red = value >> 24
            green = value >> 16 & 0xFF
            blue = value >> 8 & 0xFF
            alpha = value & 0xFF
        default:
            red = value >> 16
            green = value >> 8 & 0xFF
            blue = value & 0xFF
            alpha = 0xFF
        }
        self.init(
            .sRGB,
            red: Double(red) / 255,
            green: Double(green) / 255,
            blue: Double(blue) / 255,
            opacity: Double(alpha) / 255
        )
    }
}

extension View {
    func brandCard() -> some View {
        self
            .background(.background, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            .shadow(color: .black.opacity(0.06), radius: 20, y: 8)
    }
}
