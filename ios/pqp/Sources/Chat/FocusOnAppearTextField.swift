import SwiftUI
import UIKit

/// A single-line search field that takes the keyboard the moment it is on
/// screen. SwiftUI's `@FocusState` cannot do this for a field living in a
/// navigation bar item (the request is dropped), which is where the forum's
/// search sits.
struct FocusOnAppearTextField: UIViewRepresentable {
    @Binding var text: String
    let placeholder: String

    func makeUIView(context: Context) -> Field {
        let field = Field()
        field.font = .systemFont(ofSize: 16)
        field.textColor = UIColor(Palette.paper)
        field.tintColor = UIColor(Palette.signal)
        field.attributedPlaceholder = NSAttributedString(
            string: placeholder, attributes: [.foregroundColor: UIColor(Palette.paperMuted)]
        )
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
        field.returnKeyType = .search
        field.clearButtonMode = .never
        field.setContentHuggingPriority(.defaultLow, for: .horizontal)
        field.delegate = context.coordinator
        field.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .editingChanged)
        return field
    }

    func updateUIView(_ field: Field, context: Context) {
        if field.text != text { field.text = text }
    }

    func makeCoordinator() -> Coordinator { Coordinator(text: $text) }

    final class Coordinator: NSObject, UITextFieldDelegate {
        var text: Binding<String>
        init(text: Binding<String>) { self.text = text }

        @objc func changed(_ field: UITextField) { text.wrappedValue = field.text ?? "" }

        func textFieldShouldReturn(_ field: UITextField) -> Bool {
            field.resignFirstResponder()
            return true
        }
    }

    /// Asks for the keyboard once, when it first has a window.
    final class Field: UITextField {
        private var asked = false

        override func didMoveToWindow() {
            super.didMoveToWindow()
            guard window != nil, !asked else { return }
            asked = true
            DispatchQueue.main.async { [weak self] in _ = self?.becomeFirstResponder() }
        }
    }
}
