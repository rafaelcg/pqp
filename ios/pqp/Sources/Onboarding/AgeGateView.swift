import SwiftUI

/// The 18+ declaration. Shown as a phase, not a sheet — there is nothing
/// behind it to dismiss to, because the server refuses every other route until
/// it is answered.
///
/// Three separate fields rather than a date wheel, mirroring the web client:
/// a picker defaulting to today invites mis-submitting "born today", and the
/// gate allows exactly one attempt.
struct AgeGateView: View {
    @Environment(SessionStore.self) private var session

    @State private var day = ""
    @State private var month = 0
    @State private var year = ""
    @State private var submitting = false
    @State private var error: String?

    /// Localized month names — Calendar hands these out in the app's locale.
    private let monthNames = Calendar.current.monthSymbols

    private var dateOfBirth: String? {
        guard let dayValue = Int(day), (1...31).contains(dayValue),
              (1...12).contains(month),
              let yearValue = Int(year), (1900...2100).contains(yearValue)
        else { return nil }
        return String(format: "%04d-%02d-%02d", yearValue, month, dayValue)
    }

    var body: some View {
        ZStack {
            Palette.ink.ignoresSafeArea()

            VStack(spacing: 0) {
                Spacer(minLength: 0)

                SpeechMark(size: 64)
                    .padding(.bottom, 28)

                Text("Confirm your age")
                    .font(Typography.display(28))
                    .foregroundStyle(Palette.paper)
                    .multilineTextAlignment(.center)

                Text("pqp is for people aged 18 and over. Enter your date of birth to continue. You can only answer once.")
                    .font(Typography.body)
                    .foregroundStyle(Palette.paperMuted)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 320)
                    .padding(.top, 12)

                fields
                    .padding(.top, 28)

                if let error {
                    Text(error)
                        .font(Typography.callout)
                        .foregroundStyle(Palette.danger)
                        .multilineTextAlignment(.center)
                        .padding(.top, 14)
                        .transition(.opacity)
                }

                Spacer(minLength: 0)

                VStack(spacing: 12) {
                    Button(submitting ? "Checking…" : "Continue") {
                        Task { await submit() }
                    }
                    .buttonStyle(PrimaryButtonStyle(isEnabled: dateOfBirth != nil))
                    .disabled(dateOfBirth == nil || submitting)
                    .accessibilityIdentifier("ageGate.submit")

                    // The way out for a wrong account — not a way around the
                    // question, which has no "later".
                    Button("Sign out") {
                        Task { await session.signOut() }
                    }
                    .font(Typography.callout)
                    .foregroundStyle(Palette.paperMuted)
                }
                .padding(.horizontal, 24)
                .padding(.bottom, 16)
            }
            .padding(.horizontal, Metrics.hPadding)
        }
        .animation(Motion.standard, value: error)
    }

    private var fields: some View {
        HStack(spacing: 10) {
            labelled("Day") {
                TextField("31", text: $day)
                    .keyboardType(.numberPad)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("ageGate.day")
                    .frame(width: 64)
            }

            labelled("Month") {
                Menu {
                    ForEach(1...12, id: \.self) { index in
                        Button(monthNames[index - 1]) { month = index }
                    }
                } label: {
                    HStack(spacing: 6) {
                        Text(month == 0 ? String(localized: "Choose") : monthNames[month - 1])
                            .foregroundStyle(month == 0 ? Palette.paperMuted : Palette.paper)
                            .lineLimit(1)
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.system(size: 10))
                            .foregroundStyle(Palette.paperMuted)
                    }
                    .frame(minWidth: 96)
                }
                .accessibilityIdentifier("ageGate.month")
            }

            labelled("Year") {
                TextField("1990", text: $year)
                    .keyboardType(.numberPad)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("ageGate.year")
                    .frame(width: 76)
            }
        }
    }

    private func labelled(_ label: LocalizedStringKey, @ViewBuilder content: () -> some View) -> some View {
        VStack(spacing: 6) {
            Text(label)
                .font(Typography.label)
                .tracking(1)
                .foregroundStyle(Palette.paperMuted)
                .textCase(.uppercase)
            content()
                .font(Typography.body)
                .foregroundStyle(Palette.paper)
                .padding(.vertical, 11)
                .padding(.horizontal, 10)
                .pqpSurface(cornerRadius: Metrics.cornerRadiusSmall)
        }
    }

    private func submit() async {
        guard let dateOfBirth else { return }
        submitting = true
        error = await session.submitAgeDeclaration(dateOfBirth: dateOfBirth)
        submitting = false
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
