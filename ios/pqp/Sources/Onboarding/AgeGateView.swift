import SwiftUI

/// Screen one of the first run: the 18+ declaration.
///
/// Drawn inside the wizard's shell (same dots, same mark, same glow) rather
/// than as a screen of its own, so it reads as the first step of getting in
/// and not as a wall before it. Still a session phase, not a sheet: there is
/// nothing behind it to dismiss to, because the server refuses every other
/// route until it is answered.
///
/// Three decisions kept from V1, and the reason each exists:
/// - THREE FIELDS, NOT A DATE WHEEL. A picker defaulting to today invites
///   mis-submitting "born today", and the gate allows exactly one attempt.
/// - THE ONE-ATTEMPT RULE IS SAID BEFORE THE FIELD IS SUBMITTED, in the only
///   prose on the screen. Being told afterwards is being told too late.
/// - NO WAY AROUND IT. "Sign out" is the way out for a wrong account, not a
///   "later": the question has no later.
///
/// Focus moves itself: two digits in Day hands over to Month, choosing a month
/// hands over to Year, so the whole answer is three touches on a number pad.
struct AgeStep: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The age the server enforces. Written once, used in every sentence.
    static let minimumAge = 18

    @State private var day = ""
    @State private var month = 0
    @State private var year = ""
    @State private var submitting = false
    @State private var error: String?
    @State private var failures = 0
    /// Draws the eye to Month once Day is done, because a menu cannot be
    /// opened on somebody's behalf.
    @State private var nudgeMonth = false
    @FocusState private var focus: Field?

    private enum Field: Hashable { case day, year }

    /// Localized month names. Calendar hands these out in the app's locale.
    private let monthNames = Calendar.current.monthSymbols

    private var dateOfBirth: String? {
        guard let dayValue = Int(day), (1...31).contains(dayValue),
              (1...12).contains(month),
              let yearValue = Int(year),
              (1900...Calendar.current.component(.year, from: Date())).contains(yearValue)
        else { return nil }
        return String(format: "%04d-%02d-%02d", yearValue, month, dayValue)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                StepHeading(
                    eyebrow: Text("Just once"),
                    title: Text("Your date of birth"),
                    description: Text("pqp is \(Self.minimumAge)+. We ask once and take your word for it."),
                    eyebrowIcon: "checkmark.shield"
                )

                fields

                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "exclamationmark.circle")
                        .foregroundStyle(Palette.warning)
                        .accessibilityHidden(true)
                    Text("Check it before you continue: this answer cannot be changed later, and a date under \(Self.minimumAge) closes the account on the spot.")
                        .font(FirstRunType.footnote)
                        .foregroundStyle(Palette.paperSubtle)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(14)
                .background(
                    RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                        .fill(Palette.warning.opacity(0.08))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                        .strokeBorder(Palette.warning.opacity(0.25), lineWidth: 1)
                )
                .accessibilityElement(children: .combine)

                if let error {
                    Label(error, systemImage: "xmark.octagon.fill")
                        .font(FirstRunType.callout)
                        .foregroundStyle(Palette.danger)
                        .transition(.opacity)
                        .accessibilityIdentifier("ageGate.error")
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 12)
            .padding(.bottom, 24)
        }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            Button {
                Task { await submit() }
            } label: {
                HStack(spacing: 8) {
                    if submitting { ProgressView().tint(Palette.inkDeep) }
                    Text(submitting ? "Saving…" : "Continue")
                }
            }
            .buttonStyle(PrimaryButtonStyle(isEnabled: dateOfBirth != nil))
            .disabled(dateOfBirth == nil || submitting)
            .accessibilityIdentifier("ageGate.submit")
            .padding(.horizontal, 20)
            .padding(.top, 10)
            .padding(.bottom, 12)
            .background { FooterScrim() }
        }
        .animation(.easeInOut(duration: 0.2), value: error)
        .sensoryFeedback(.error, trigger: failures)
        .task {
            // After the step has landed, so the keyboard does not rise into a
            // screen that is still moving.
            try? await Task.sleep(for: .milliseconds(550))
            if day.isEmpty { focus = .day }
        }
    }

    private var fields: some View {
        HStack(alignment: .bottom, spacing: 10) {
            labelled("Day") {
                TextField("DD", text: $day)
                    .keyboardType(.numberPad)
                    .textContentType(.dateTime)
                    .multilineTextAlignment(.center)
                    .focused($focus, equals: .day)
                    .accessibilityIdentifier("ageGate.day")
                    .onChange(of: day) { _, value in
                        let digits = String(value.filter(\.isNumber).prefix(2))
                        if digits != value { day = digits }
                        guard digits.count == 2 else { return }
                        if month == 0 {
                            focus = nil
                            nudgeMonth = true
                        } else if year.count < 4 {
                            focus = .year
                        }
                    }
            }
            .frame(width: 76)

            labelled("Month") {
                Menu {
                    ForEach(1...12, id: \.self) { index in
                        Button(monthNames[index - 1]) {
                            month = index
                            nudgeMonth = false
                            if year.count < 4 { focus = .year }
                        }
                    }
                } label: {
                    HStack(spacing: 6) {
                        Text(month == 0 ? String(localized: "Choose") : monthNames[month - 1])
                            .foregroundStyle(month == 0 ? Palette.paperMuted : Palette.paper)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.caption2)
                            .foregroundStyle(Palette.paperMuted)
                    }
                }
                .accessibilityIdentifier("ageGate.month")
            }
            .overlay(
                RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous)
                    .strokeBorder(Palette.signal, lineWidth: nudgeMonth ? 2 : 0)
                    .padding(.top, 24)
                    .animation(reduceMotion ? nil : .easeInOut(duration: 0.6).repeatCount(3), value: nudgeMonth)
            )

            labelled("Year") {
                TextField("YYYY", text: $year)
                    .keyboardType(.numberPad)
                    .multilineTextAlignment(.center)
                    .focused($focus, equals: .year)
                    .accessibilityIdentifier("ageGate.year")
                    .onChange(of: year) { _, value in
                        let digits = String(value.filter(\.isNumber).prefix(4))
                        if digits != value { year = digits }
                        if digits.count == 4 { focus = nil }
                    }
            }
            .frame(width: 96)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("Date of birth"))
    }

    private func labelled(_ label: LocalizedStringKey, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label)
                .font(FirstRunType.eyebrow)
                .tracking(1)
                .foregroundStyle(Palette.paperMuted)
                .textCase(.uppercase)
            content()
                .font(.title3.weight(.semibold).monospacedDigit())
                .foregroundStyle(Palette.paper)
                .padding(.vertical, 12)
                .padding(.horizontal, 12)
                .frame(minHeight: 52)
                .background(
                    RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous)
                        .fill(Palette.surface)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous)
                        .strokeBorder(Palette.border, lineWidth: 1)
                )
        }
    }

    private func submit() async {
        guard let dateOfBirth else { return }
        focus = nil
        submitting = true
        error = await session.submitAgeDeclaration(dateOfBirth: dateOfBirth)
        submitting = false
        if error != nil { failures += 1 }
    }
}

/// The terminal screen for an account that declared under 18. Deliberately
/// quiet and final: there is one attempt and no self-serve way out, and the
/// person reading this has just been told they cannot use the product.
struct AgeBlockedView: View {
    @Environment(SessionStore.self) private var session

    var body: some View {
        ZStack {
            Palette.ink.ignoresSafeArea()

            VStack(spacing: 16) {
                Spacer(minLength: 0)

                Image(systemName: "hand.raised")
                    .font(.system(size: 40))
                    .foregroundStyle(Palette.paperMuted)

                Text("This account can't be used")
                    .font(Typography.title(22))
                    .foregroundStyle(Palette.paper)
                    .multilineTextAlignment(.center)

                Text("The date of birth on file is under 18. pqp's Terms require everyone to be 18 or older.")
                    .font(Typography.body)
                    .foregroundStyle(Palette.paperMuted)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 320)

                Spacer(minLength: 0)

                Button("Sign out") {
                    Task { await session.signOut() }
                }
                .buttonStyle(SecondaryButtonStyle())
                .padding(.horizontal, 24)
                .padding(.bottom, 16)
            }
            .padding(.horizontal, Metrics.hPadding)
        }
    }
}
