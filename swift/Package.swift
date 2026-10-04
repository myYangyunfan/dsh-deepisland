// swift-tools-version:5.8
import PackageDescription

let package = Package(
    name: "DSHNotch",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "DSHNotch",
            path: "Sources/DSHNotch",
            swiftSettings: [.unsafeFlags(["-parse-as-library"])]
        )
    ]
)
