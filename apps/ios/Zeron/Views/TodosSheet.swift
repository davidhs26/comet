// To-do chip (ID01-503): the status strip's HUD data + its read-only sheet.
// The engine folds the agent's to-dos into ONE synthetic tool call under the
// stable `acp-plan` id (crates/harness/src/acp/normalize.rs — ACP `plan`
// updates and the todos extension's set_todos/update_todo both feed it), so
// the LAST `todo` part in the session doc is always the current list. This
// file is the phone-side reader (JSON echo → items) and the sheet the strip's
// `⏳ d/n` chip opens; the transcript itself skips the `todo` part
// (TranscriptRows) — the HUD replaces it.

import SwiftUI

// MARK: - Model + decode

/// One to-do as the wire compressed it (proto TodoItem: text + done only;
/// id/status/note fold into the text — "text — note" for in-progress notes).
struct TodoDisplayItem: Hashable {
    let text: String
    let done: Bool
}

/// The `todo` tool part's items, from the doc's JSON echo.
///
/// The engine writes the whole call to the doc (`{kind: "todo", items:
/// [{text, done}]}`); SessionStore's decode keeps each list element as the
/// Swift dictionary DESCRIPTION string of the map (`fields["items"]` —
/// `"[\"done\": true, \"text\": \"fix\"]"`: quoted values with Swift
/// escapes, bare literals, unstable key order, and keys that may print bare
/// OR quoted depending on the toolchain). The parser below therefore never
/// assumes key order or quoting — both spellings are accepted.
enum TodoEcho {
    /// `nil` = the part has no decodable items list (treated as an empty
    /// list — a cleared or corrupt chip retires, it does not resurrect the
    /// previous one).
    static func items(fromFields fields: [String: AnyHashable]) -> [TodoDisplayItem]? {
        guard let rows = fields["items"] as? [String] else { return nil }
        return rows.compactMap(parse)
    }

    private static func parse(_ row: String) -> TodoDisplayItem? {
        let trimmed = Substring(row.trimmingCharacters(in: .whitespacesAndNewlines))
        guard trimmed.hasPrefix("["), trimmed.hasSuffix("]") else { return nil }
        var rest = skipWS(trimmed.dropFirst().dropLast())
        var text: String?
        var done: Bool?
        while !rest.isEmpty {
            guard let (key, afterKey) = scanKey(rest) else { break }
            rest = skipWS(afterKey)
            guard rest.first == ":" else { break }
            guard let (value, afterValue) = scanValue(skipWS(rest.dropFirst())) else { break }
            switch key {
            case "text":
                if case .string(let s) = value { text = s }
            case "done":
                if case .bool(let b) = value { done = b }
            default:
                break
            }
            rest = skipWS(afterValue)
            if rest.first == "," {
                rest = skipWS(rest.dropFirst())
            } else {
                break
            }
        }
        guard let text, !text.isEmpty, let done else { return nil }
        return TodoDisplayItem(text: text, done: done)
    }

    private enum EchoValue {
        case string(String)
        case bool(Bool)
        case other
    }

    private static func skipWS(_ s: Substring) -> Substring {
        var i = s.startIndex
        while i < s.endIndex, s[i] == " " || s[i] == "\t" {
            s.formIndex(after: &i)
        }
        return s[i...]
    }

    /// One key: a bare identifier up to its `:`, or a quoted string — the
    /// dictionary description may print String keys either way.
    private static func scanKey(_ s: Substring) -> (String, Substring)? {
        if s.first == "\"" {
            // Quoted key: reuse the string scanner; the caller then expects
            // the `:` after the closing quote.
            return scanString(s.dropFirst())
        }
        guard let end = s.firstIndex(where: { $0 == ":" }) else { return nil }
        let key = s[..<end].trimmingCharacters(in: .whitespaces)
        guard !key.isEmpty else { return nil }
        return (key, s[end...])
    }

    /// One value: a quoted string (Swift literal escapes) or a bare literal
    /// (true/false/number) consumed up to — not including — its delimiter.
    private static func scanValue(_ s: Substring) -> (EchoValue, Substring)? {
        guard let first = s.first else { return nil }
        if first == "\"" {
            return scanString(s.dropFirst()).map { (.string($0.0), $0.1) }
        }
        // Bare literal: up to the structural delimiter (or end).
        let end = s.firstIndex(where: { $0 == "," || $0 == "]" || $0 == "}" }) ?? s.endIndex
        let token = s[..<end].trimmingCharacters(in: .whitespaces)
        switch token {
        case "true": return (.bool(true), s[end...])
        case "false": return (.bool(false), s[end...])
        default: return (.other, s[end...])
        }
    }

    /// Quoted string body (opening `"` already consumed) with Swift literal
    /// escapes (\" \\ \n \t \r \0 \u{…}); returns the value and the rest
    /// starting AFTER the closing quote.
    private static func scanString(_ s: Substring) -> (String, Substring)? {
        var out = ""
        var i = s.startIndex
        while i < s.endIndex {
            let c = s[i]
            if c == "\"" {
                return (out, s[s.index(after: i)...])
            }
            if c == "\\", s.index(after: i) < s.endIndex {
                let esc = s[s.index(after: i)]
                switch esc {
                case "n": out.append("\n")
                case "t": out.append("\t")
                case "r": out.append("\r")
                case "0": out.append("\u{0}")
                case "u":
                    // \u{XXXX}
                    var j = s.index(s.index(after: i), offsetBy: 1)
                    if j < s.endIndex, s[j] == "{" {
                        s.formIndex(after: &j)
                        var hex = ""
                        while j < s.endIndex, s[j] != "}" {
                            hex.append(s[j])
                            s.formIndex(after: &j)
                        }
                        if j < s.endIndex, let v = UInt32(hex, radix: 16),
                           let scalar = Unicode.Scalar(v) {
                            out.unicodeScalars.append(scalar)
                            i = s.index(after: j)
                            continue
                        }
                    }
                    out.append("u")
                default:
                    out.append(esc)  // \" \\ \' and anything unrecognized
                }
                i = s.index(after: s.index(after: i))
            } else {
                out.append(c)
                i = s.index(after: i)
            }
        }
        return nil  // unterminated string
    }
}

// MARK: - SessionStore read (the HUD's source)

extension SessionStore {
    /// The current to-do list: the LAST `todo` tool part in the doc (the
    /// engine folds every refresh into the one stable `acp-plan` id, so the
    /// last one is the live list). `nil` = the session never had one;
    /// `[]` = present but empty (chip retired).
    var latestTodoItems: [TodoDisplayItem]? {
        Self.latestTodoItems(in: entries)
    }

    nonisolated static func latestTodoItems(in entries: [MessageEntry]) -> [TodoDisplayItem]? {
        for entry in entries.reversed() {
            for part in entry.parts.reversed() {
                if case .tool(_, let call, _, _, _) = part, call.tag == "todo" {
                    return TodoEcho.items(fromFields: call.fields) ?? []
                }
            }
        }
        return nil
    }
}

// MARK: - Sheet

/// Read-only to-do sheet (ID01-503): checkboxes over the chip's items, done
/// items struck out and dimmed. Composition follows SheetUI (grouped card,
/// hairline separators); editing is out of scope for v1.
struct TodosSheet: View {
    let items: [TodoDisplayItem]

    var body: some View {
        ScrollView {
            VStack(spacing: 12) {
                SheetLabel("To-dos")
                SheetCard {
                    ForEach(Array(items.enumerated()), id: \.offset) { ix, item in
                        row(item)
                        if ix < items.count - 1 {
                            SheetSeparator()
                        }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Theme.bg)
        .presentationDetents([.medium, .large])
    }

    private func row(_ item: TodoDisplayItem) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: item.done ? "checkmark.square.fill" : "square")
                .font(.system(size: 15))
                .foregroundStyle(item.done ? Theme.textMuted : Theme.text)
                .padding(.top, 1)
            Text(item.text)
                .font(Theme.sans(14))
                .foregroundStyle(item.done ? Theme.textFaint : Theme.text)
                .strikethrough(item.done, color: Theme.textFaint)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 11)
    }
}
