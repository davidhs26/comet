// Subagent spawn-stamp decode (ID01-485): the engine stamps
// subagentRef/subagentStatus/subagentTail on the parent chat's tool part
// (crates/doc/src/schema.rs:558-564). Parts predating the keys must keep
// decoding (nil stamp), and an unknown/absent status reads as in-flight —
// never a fabricated `failed`. Runs on the Mac toolchain (the Beelink has
// no swiftc; see docs/PARITY.md "iOS subagents").

import XCTest
import Loro
@testable import Zeron

final class SubagentDecodeTests: XCTestCase {
    /// A session doc with one assistant entry carrying one tool part — the
    /// spawn shape the observer mints (`Agent: {id} ({role})` as an Unknown
    /// call). `stamp` merges the subagent keys in; `isError` mirrors the
    /// engine's resolution marker (presence IS the marker, schema.rs:96 —
    /// a running subagent has none).
    private func toolDoc(stamp: [String: Any] = [:], isError: Any? = nil) throws -> LoroDoc {
        let doc = LoroDoc()
        let messages = doc.getList(id: "messages")
        let entry = try messages.pushContainer(child: LoroMap())
        try entry.insert(key: "id", v: "m1")
        try entry.insert(key: "role", v: "assistant")
        try entry.insert(key: "deviceId", v: "dev-a")
        try entry.insert(key: "createdAt", v: Int64(1))
        try entry.insert(key: "status", v: "complete")
        var part: [String: Any] = [
            "id": "p1",
            "kind": "tool",
            "call": ["kind": "unknown", "name": "Agent: t1 (research)"],
        ]
        stamp.forEach { part[$0.key] = $0.value }
        if let isError { part["isError"] = isError }
        try entry.insert(key: "parts", v: LoroValue.fromJSON([part]))
        doc.commit()
        return doc
    }

    /// decodeEntries is nonisolated + pure over the doc — the same entry
    /// point the room projection uses.
    private func firstTool(_ doc: LoroDoc) -> MessagePart? {
        SessionStore.decodeEntries(from: doc)?.first?.parts.first
    }

    func testDecodesSpawnStamp() throws {
        let part = firstTool(try toolDoc(stamp: [
            "subagentRef": "chat1--sub--tu1",
            "subagentStatus": "running",
            "subagentTail": "reading schema.rs:558",
        ]))
        guard case .tool(_, let call, _, _, let subagent)? = part else {
            return XCTFail("expected a tool part, got \(String(describing: part))")
        }
        XCTAssertEqual(call.string("name"), "Agent: t1 (research)")
        XCTAssertEqual(agentChipDetail(name: call.string("name"),
                                        fallback: "chat1--sub--tu1"),
                         "t1 (research)")
        XCTAssertEqual(subagent?.docId, "chat1--sub--tu1")
        XCTAssertEqual(subagent?.status, .running)
        XCTAssertEqual(subagent?.tail, "reading schema.rs:558")
    }

    func testDoneAndFailedStatusesDecode() throws {
        for status in [SubagentStatus.done, .failed] {
            let part = firstTool(try toolDoc(stamp: [
                "subagentRef": "chat1--sub--tu1",
                "subagentStatus": status.rawValue,
            ], isError: false))
            guard case .tool(_, _, _, _, let subagent)? = part else {
                return XCTFail("expected a tool part for \(status.rawValue)")
            }
            XCTAssertEqual(subagent?.status, status)
        }
    }

    func testPartsPrecedingTheStampDecodeAsPlainTools() throws {
        let part = firstTool(try toolDoc())
        guard case .tool(_, let call, let isError, let resolved, let subagent)? = part else {
            return XCTFail("expected a tool part, got \(String(describing: part))")
        }
        // Retrocompatible: nothing about the legacy shape changes.
        XCTAssertEqual(call.tag, "unknown")
        XCTAssertEqual(isError, false)
        XCTAssertEqual(resolved, false)  // no isError key → unresolved
        XCTAssertNil(subagent)
    }

    func testUnknownOrAbsentStatusReadsAsInFlight() throws {
        // [[String: Any]] explicit: the literals alone would infer
        // [[String: String]], which is not convertible to the stamp type.
        let stamps: [[String: Any]] = [
            ["subagentRef": "chat1--sub--tu1", "subagentStatus": "bogus"],
            ["subagentRef": "chat1--sub--tu1"],
        ]
        for stamp in stamps {
            let part = firstTool(try toolDoc(stamp: stamp))
            guard case .tool(_, _, _, _, let subagent)? = part else {
                return XCTFail("expected a tool part, got \(String(describing: part))")
            }
            XCTAssertEqual(subagent?.status, .running,
                           "silence must read as in-flight, never failed")
        }
    }
}
