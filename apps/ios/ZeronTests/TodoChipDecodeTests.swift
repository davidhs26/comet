// To-do chip decode (ID01-503): the engine folds the agent's to-dos into one
// synthetic `acp-plan` tool call (crates/harness/src/acp/normalize.rs — ACP
// `plan` + the todos extension's set_todos/update_todo), written to the doc
// as `call = {kind: "todo", items: [{text, done}]}`. The iOS decode keeps
// each item as the Swift dictionary DESCRIPTION string (the "JSON echo",
// SessionStore.partFrom), so the chip's reader (TodoEcho) parses that shape.
// These tests pin the full path: doc → decodeEntries → latestTodoItems.
// Runs on the Mac toolchain (no swiftc on the Beelink; docs/PARITY.md).

import XCTest
import Loro
@testable import Zeron

final class TodoChipDecodeTests: XCTestCase {
    /// A session doc with one assistant entry per items-list; each entry
    /// carries a `todo` tool part shaped like the engine's render of the
    /// synthetic acp-plan call (same construction path as the Subagent
    /// decode tests — LoroValue.fromJSON → doc → decodeEntries).
    private func todoDoc(lists: [[[String: Any]]]) throws -> LoroDoc {
        let doc = LoroDoc()
        let messages = doc.getList(id: "messages")
        for (n, items) in lists.enumerated() {
            let entry = try messages.pushContainer(child: LoroMap())
            try entry.insert(key: "id", v: "m\(n)")
            try entry.insert(key: "role", v: "assistant")
            try entry.insert(key: "deviceId", v: "dev-a")
            try entry.insert(key: "createdAt", v: Int64(n + 1))
            try entry.insert(key: "status", v: "complete")
            let part: [String: Any] = [
                "id": "p\(n)",
                "kind": "tool",
                "call": ["kind": "todo", "items": items],
            ]
            try entry.insert(key: "parts", v: LoroValue.fromJSON([part]))
        }
        doc.commit()
        return doc
    }

    private func items(_ doc: LoroDoc) -> [TodoDisplayItem]? {
        guard let entries = SessionStore.decodeEntries(from: doc) else {
            return nil
        }
        return SessionStore.latestTodoItems(in: entries)
    }

    func testDecodesItemsFromJSONEcho() throws {
        let items = items(try todoDoc(lists: [[
            ["text": "leer normalize.rs", "done": true],
            ["text": "escribir tests — en normalize.rs", "done": false],
        ]]))
        XCTAssertEqual(items, [
            TodoDisplayItem(text: "leer normalize.rs", done: true),
            TodoDisplayItem(text: "escribir tests — en normalize.rs", done: false),
        ])
    }

    /// The echo is the Swift dictionary description — strings carry Swift
    /// literal escapes, and key order is unstable (dictionary). Both must
    /// survive the parse.
    func testEscapedTextDecodes() throws {
        let tricky = "comillas \" adentro, barra \\ y salto\nde línea — emoji 🛠️"
        let items = items(try todoDoc(lists: [[
            ["done": false, "text": tricky],   // keys deliberately flipped
        ]]))
        XCTAssertEqual(items?.first?.text, tricky)
        XCTAssertEqual(items?.first?.done, false)
    }

    /// The stable `acp-plan` id folds in place — the LAST todo part wins.
    func testLatestTodoPartWins() throws {
        let items = items(try todoDoc(lists: [
            [["text": "vieja lista", "done": false]],
            [["text": "nueva lista", "done": true]],
        ]))
        XCTAssertEqual(items, [TodoDisplayItem(text: "nueva lista", done: true)])
    }

    /// No todo part → nil (never had a chip); an empty items list → []
    /// (present but cleared — the chip retires, it does not resurrect the
    /// previous list).
    func testEmptyAndAbsentLists() throws {
        XCTAssertNil(items(try execDoc()))
        let empty = items(try todoDoc(lists: [[]]))
        XCTAssertEqual(empty, [])
    }

    /// A non-todo tool part must never feed the chip.
    private func execDoc() throws -> LoroDoc {
        let doc = LoroDoc()
        let messages = doc.getList(id: "messages")
        let entry = try messages.pushContainer(child: LoroMap())
        try entry.insert(key: "id", v: "m1")
        try entry.insert(key: "role", v: "assistant")
        try entry.insert(key: "deviceId", v: "dev-a")
        try entry.insert(key: "createdAt", v: Int64(1))
        try entry.insert(key: "status", v: "complete")
        let part: [String: Any] = [
            "id": "p1",
            "kind": "tool",
            "call": ["kind": "exec", "command": "ls"],
        ]
        try entry.insert(key: "parts", v: LoroValue.fromJSON([part]))
        doc.commit()
        return doc
    }
}
