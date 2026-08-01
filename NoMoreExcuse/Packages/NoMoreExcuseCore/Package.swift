// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "NoMoreExcuseCore",
    platforms: [
        .iOS(.v17),
        .macOS(.v13)
    ],
    products: [
        .library(name: "NoMoreExcuseCore", targets: ["NoMoreExcuseCore"])
    ],
    targets: [
        .target(name: "NoMoreExcuseCore"),
        .testTarget(
            name: "NoMoreExcuseCoreTests",
            dependencies: ["NoMoreExcuseCore"]
        )
    ]
)
