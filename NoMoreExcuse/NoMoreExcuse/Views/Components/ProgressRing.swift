import SwiftUI

struct ProgressRing: View {
    var progress: Double
    var lineWidth: CGFloat = 10
    var color: Color = Brand.primary
    var size: CGFloat = 72

    var body: some View {
        ZStack {
            Circle()
                .stroke(color.opacity(0.15), lineWidth: lineWidth)
            Circle()
                .trim(from: 0, to: min(max(progress, 0), 1))
                .stroke(
                    color,
                    style: StrokeStyle(lineWidth: lineWidth, lineCap: .round)
                )
                .rotationEffect(.degrees(-90))
                .animation(.spring(response: 0.45, dampingFraction: 0.8), value: progress)
        }
        .frame(width: size, height: size)
    }
}
