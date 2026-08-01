# No More Excuse

An original, local-first habit and accountability app for iPhone.

**Brand:** No More Excuse  
**Creator:** Muhammed Hassan  
**Current stage:** 0.1 native SwiftUI MVP

## Included in the MVP

- Today dashboard with a Saturday-first week strip and daily score.
- Check, count, duration, and avoid-habit types.
- Built-in focus timer with incremental progress saving.
- Repeat days, optional reminders, editing, and archiving-ready models.
- Weekly consistency, momentum heatmap, and streak insights.
- Accountability-circle preview and native share sheet.
- English and Arabic RTL modes, light/dark/system themes.
- Local JSON persistence and exportable backup.
- Core habit engine covered by Swift tests.

## Run it

1. Install the latest stable Xcode from the Mac App Store and launch it once.
2. Open the generated project:

   ```bash
   cd /Users/mac/Documents/MagnetOS/NoMoreExcuse
   open NoMoreExcuse.xcodeproj
   ```

3. In Xcode, choose an iPhone simulator and press Run. For a physical iPhone, select Muhammed Hassan's Apple Developer team under Signing & Capabilities.

XcodeGen is only required after adding or deleting source files. The checked-in `project.yml` can regenerate the project with XcodeGen 2.45.4 or newer.

The current machine has Swift command-line tools but not the full Xcode installation, so simulator and signing verification must wait until Xcode is installed.

## Verify the core

```bash
swift test --package-path Packages/NoMoreExcuseCore
```

## Deliberately not copied from Grit

This project matches the product category and expected capabilities, but uses original navigation, branding, copy, score system, visuals, and data model. No competitor assets or source code are included.

## Next production phases

1. Real account-based accountability sharing and encrypted cloud sync.
2. StoreKit 2 subscription products and a fair paywall.
3. WidgetKit, App Intents/Siri, HealthKit, and Apple Watch.
4. App Store screenshots, privacy policy, analytics consent, QA, and TestFlight.
