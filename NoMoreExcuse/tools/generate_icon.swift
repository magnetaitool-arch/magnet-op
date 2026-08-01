import AppKit

let size = NSSize(width: 1024, height: 1024)
let image = NSImage(size: size)
image.lockFocus()

let bounds = NSRect(origin: .zero, size: size)
let gradient = NSGradient(colors: [
    NSColor(calibratedRed: 0.22, green: 0.24, blue: 0.96, alpha: 1),
    NSColor(calibratedRed: 0.56, green: 0.28, blue: 0.94, alpha: 1)
])!
gradient.draw(in: bounds, angle: -42)

let glow = NSBezierPath(ovalIn: NSRect(x: 590, y: 590, width: 520, height: 520))
NSColor(calibratedRed: 0.15, green: 0.92, blue: 0.67, alpha: 0.26).setFill()
glow.fill()

let mark = NSBezierPath()
mark.move(to: NSPoint(x: 238, y: 525))
mark.line(to: NSPoint(x: 430, y: 330))
mark.line(to: NSPoint(x: 790, y: 710))
mark.lineWidth = 92
mark.lineCapStyle = .round
mark.lineJoinStyle = .round
NSColor.white.setStroke()
mark.stroke()

let spark = NSBezierPath(ovalIn: NSRect(x: 708, y: 665, width: 112, height: 112))
NSColor(calibratedRed: 1.0, green: 0.77, blue: 0.25, alpha: 1).setFill()
spark.fill()

let paragraph = NSMutableParagraphStyle()
paragraph.alignment = .center
let attributes: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 76, weight: .black),
    .foregroundColor: NSColor.white.withAlphaComponent(0.9),
    .paragraphStyle: paragraph,
    .kern: 8
]
NSString(string: "NME").draw(in: NSRect(x: 220, y: 125, width: 584, height: 100), withAttributes: attributes)

image.unlockFocus()

guard let tiff = image.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff),
      let png = bitmap.representation(using: .png, properties: [:]) else {
    fatalError("Unable to render app icon")
}

let output = CommandLine.arguments.dropFirst().first ?? "AppIcon-1024.png"
try png.write(to: URL(fileURLWithPath: output), options: .atomic)
print(output)
