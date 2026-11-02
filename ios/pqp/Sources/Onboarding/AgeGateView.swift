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
///
/// THE READ-BACK. A typed date is the one input nobody can take back, and the
/// usual way it goes wrong is a slip (a swapped day and month, a year that is
/// not the one meant), not a lie. So, with `ageGateReadback` on, Continue sends
/// nothing: it says the date back in words ("Tu nasceu em 3 de dezembro de
/// 2008") and only "Está certo" sends it. "Corrigir" returns to the fields with
/// what was typed still in them. Everybody gets the same step, so it leaks
/// nothing about the verdict. Off, Continue sends directly, as it always did.
/// The step is state of this view, not a pushed screen, so there is no back
/// gesture that could leave the gate. A 400 from the server (a date under the
/// plausibility floor) is the same kind of slip and never spends the attempt:
/// the fields come back, the year under the cursor. The decisions live in
/// `AgeGate`, which the tests pin.
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
    /// The read-back is a step of this screen, not a screen: the fields' state
    /// lives above it, so "Corrigir" gives back exactly what was typed.
    @State private var readingBack = false
    @AccessibilityFocusState private var readbackFocused: Bool
    /// Draws the eye to Month once Day is done, because a menu cannot be
    /// opened on somebody's behalf.
    @State private var nudgeMonth = false
    @FocusState private var focus: Field?

    private enum Field: Hashable { case day, year }

    /// Localized month names. Calendar hands these out in the app's locale.
    private let monthNames = Calendar.current.monthSymbols

    /// Everything is filled in. Whether it is a real date is Continue's answer,
    /// so that 31 February gets a sentence instead of a dead button.
    private var complete: Bool { !day.isEmpty && month != 0 && year.count == 4 }

    private var locale: Locale { AgeGate.interfaceLocale }

    /// The date in words, only while the read-back is showing. Computed from
    /// the fields on every render, never cached, so it cannot outlive an edit.
    private var readback: (isoDate: String, inWords: String)? {
        guard readingBack,
              case .readBack(let iso, let words) = AgeGate.continueOutcome(
                  day: day, month: month, year: year, readback: true, locale: locale
              )
        else { return nil }
        return (iso, words)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                StepHeading(
                    eyebrow: Text("Just once"),
                    title: readback == nil ? Text("Your date of birth") : Text("Check your date of birth"),
                    description: readback == nil
                        ? Text("pqp is \(Self.minimumAge)+. We ask once and take your word for it.")
                        : nil,
                    eyebrowIcon: "checkmark.shield"
                )

                if let readback {
                    readbackSentence(readback.inWords)
                } else {
                    fields
                }

                // Right under what it is about, above the warning: with the
                // number pad up, anything lower is behind the keyboard, which
                // is exactly when "Check the year" has to be seen.
                if let error {
                    Label(error, systemImage: "xmark.octagon.fill")
                        .font(FirstRunType.callout)
                        .foregroundStyle(Palette.danger)
                        .transition(.opacity)
                        .accessibilityIdentifier("ageGate.error")
                }

                if readback == nil { warning }
            }
            .padding(.horizontal, 20)
            .padding(.top, 12)
            .padding(.bottom, 24)
        }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            footer
        }
        .animation(.easeInOut(duration: 0.2), value: error)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: readingBack)
        .sensoryFeedback(.error, trigger: failures)
        .onChange(of: error) { _, message in
            // The sentence is drawn under a field that may be off screen, and a
            // screen reader user would not otherwise hear that the date was
            // refused.
            if let message { AccessibilityNotification.Announcement(message).post() }
        }
        .task {
            // After the step has landed, so the keyboard does not rise into a
            // screen that is still moving.
            try? await Task.sleep(for: .milliseconds(550))
            if day.isEmpty { focus = .day }
        }
    }

    /// The "do not send it yet" warning, in the only prose on the fields step.
    private var warning: some View {
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
    }

    /// The date said back. One accessibility element, and VoiceOver lands on it
    /// (not on a button) when the step appears: somebody who double-taps by
    /// reflex as the screen changes must not confirm a date they have not
    /// heard, which is what this step exists to prevent.
    private func readbackSentence(_ inWords: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("You were born on \(inWords).")
                .font(.title2.weight(.semibold))
                .foregroundStyle(Palette.paper)
                .fixedSize(horizontal: false, vertical: true)
            Text("Check the day, the month and the year.")
                .font(FirstRunType.callout)
                .foregroundStyle(Palette.paperMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityFocused($readbackFocused)
        .accessibilityIdentifier("ageGate.readback")
    }

    private var footer: some View {
        VStack(spacing: 6) {
            if let readback {
                Button {
                    Task { await submit(readback.isoDate) }
                } label: {
                    HStack(spacing: 8) {
                        if submitting { ProgressView().tint(Palette.inkDeep) }
                        Text(submitting ? "Saving…" : "That is right")
                    }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(submitting)
                .accessibilityIdentifier("ageGate.confirm")

                Button(LocalizedStringResource("ageGate.readback.edit", defaultValue: "Change it")) {
                    goBackToFields()
                }
                    .buttonStyle(SecondaryButtonStyle())
                    .disabled(submitting)
                    .accessibilityIdentifier("ageGate.edit")
            } else {
                Button {
                    Task { await onContinue() }
                } label: {
                    HStack(spacing: 8) {
                        if submitting { ProgressView().tint(Palette.inkDeep) }
                        Text(submitting ? "Saving…" : "Continue")
                    }
                }
                .buttonStyle(PrimaryButtonStyle(isEnabled: complete))
                .disabled(!complete || submitting)
                .accessibilityIdentifier("ageGate.submit")

                // The way out for a wrong account. Not a way around the
                // question, which has no "later".
                Button("Sign out") {
                    Task { await session.signOut() }
                }
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Palette.paperMuted)
                .frame(minHeight: 36)
                .disabled(submitting)
                .accessibilityIdentifier("ageGate.signOut")
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 10)
        .padding(.bottom, 12)
        .background { FooterScrim() }
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

    /// Continue: say the date back first when the switch is on, else send it.
    private func onContinue() async {
        guard !submitting else { return }
        switch AgeGate.continueOutcome(
            day: day, month: month, year: year,
            readback: session.ageGateReadback, locale: locale
        ) {
        case .badDate:
            failures += 1
            error = String(localized: "That is not a date we can read. Check the day, month and year.")
        case .submit(let iso):
            await submit(iso)
        case .readBack:
            focus = nil
            error = nil
            readingBack = true
            // After the step has been drawn, or there is nothing to focus.
            try? await Task.sleep(for: .milliseconds(150))
            readbackFocused = true
        }
    }

    private func goBackToFields() {
        guard !submitting else { return }
        error = nil
        readbackFocused = false
        readingBack = false
        refocus(.day)
    }

    /// Back on the fields after the step or a refusal changed what is on screen.
    private func refocus(_ field: Field) {
        Task {
            try? await Task.sleep(for: .milliseconds(150))
            focus = field
        }
    }

    private func submit(_ isoDate: String) async {
        guard !submitting else { return }
        focus = nil
        submitting = true
        error = nil
        let failure = await session.submitAgeDeclaration(dateOfBirth: isoDate)
        submitting = false
        guard let failure else { return }
        failures += 1
        // A 400 is the person's input, never the blocked state, and the
        // attempt is not spent: back to the fields with the values kept. Only
        // a failed save (nothing was decided) stays on the step it is on.
        switch failure {
        case .checkYear:
            error = String(localized: "Check the year. That date of birth does not look right.")
            readingBack = false
            refocus(.year)
        case .badDate:
            error = String(localized: "That is not a date we can read. Check the day, month and year.")
            readingBack = false
            refocus(.day)
        case .stale, .save:
            error = String(localized: "Could not save that. Check your connection and try again.")
        }
    }
}

/// The final screen for an account that answered under 18 (the web's
/// `AgeGateBlocked`). It used to be a bare "can't be used" with only a sign-out.
///
/// The reader may well be a child: it says what happened and what can be done,
/// accuses nobody of lying, and does not suggest signing up again. The way back
/// for somebody who typed the wrong date is on the screen itself, not one link
/// away: write to `AgeGate.appealEmail` from the account's own email address,
/// and the Terms page explains the appeal and the deletion of the account.
///
/// The two links are inside the localized sentences (markdown), so a translator
/// places them where the language wants them. `NoEmDashTests` and
/// `AgeGateTests` pin the address, the URL and the words against the web.
struct AgeBlockedView: View {
    @Environment(SessionStore.self) private var session

    var body: some View {
        ZStack {
            Palette.ink.ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    StepHeading(
                        eyebrow: Text("Age check"),
                        title: Text("pqp is for \(AgeStep.minimumAge) and over"),
                        description: Text("Thanks for answering honestly. The date of birth you gave is under \(AgeStep.minimumAge), so this account is closed. That is a rule about the service, not a judgement about you, pqp is built for adults and we are not able to make exceptions to it."),
                        eyebrowIcon: "hand.raised"
                    )

                    Text("Entered the wrong date by mistake? Write to [contato@pqp.gg](mailto:contato@pqp.gg) from this account's email address.")
                        .font(Typography.body)
                        .foregroundStyle(Palette.paper)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("ageGate.blocked.contact")

                    Text("How appeals work, and how to ask us to delete the account and the data attached to it, is on our [Terms page](https://pqp.gg/terms).")
                        .font(Typography.body)
                        .foregroundStyle(Palette.paperMuted)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("ageGate.blocked.appeal")

                    Text("Please do not open another account in the meantime, we would rather settle this one.")
                        .font(Typography.body)
                        .foregroundStyle(Palette.paperMuted)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("ageGate.blocked.wait")
                }
                .tint(Palette.signal)
                .padding(.horizontal, Metrics.hPadding)
                .padding(.top, 48)
                .padding(.bottom, 24)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                Button("Sign out") {
                    Task { await session.signOut() }
                }
                .buttonStyle(SecondaryButtonStyle())
                .padding(.horizontal, 24)
                .padding(.vertical, 12)
                .accessibilityIdentifier("ageGate.blocked.signOut")
            }
        }
    }
}
