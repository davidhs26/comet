// Subagent transcript — read-only push target of the spawn chip (ID01-485).
// The child's doc is NOT a registry chat: there is no Chat row (no deviceId,
// no roomGen) for `{chatId}--sub--{toolUseId}`, so this bypasses
// AppModel.sessionStore(for:) and gets its store from subagentStore(docId:),
// which mints it directly. Read-only by construction: TranscriptView with no
// composer, no question panel, no command surface — the child's content
// streams in through the store's own room (chat2/{subDocId}/ws), nothing
// polls.

import SwiftUI

struct SubagentView: View {
    @Environment(AppModel.self) private var model
    let parentChatId: String
    let docId: String

    @State private var scroll = ScrollState()

    var body: some View {
        Group {
            if let store = model.subagentStore(docId: docId) {
                TranscriptView(store: store, chatId: docId, scroll: scroll)
                    // TranscriptView's correctPin/settle re-pin against the
                    // composer inset's top edge, which SessionView reports via
                    // its safe-area inset. There is no composer here — a bare
                    // zero-height inset still reports a measured boundary at
                    // the physical bottom edge, so the settle loop converges
                    // on the measured path instead of the quiet-ticks timeout.
                    .safeAreaInset(edge: .bottom, spacing: 0) {
                        Color.clear
                            .frame(height: 0)
                            .onGeometryChange(for: CGFloat.self) {
                                $0.frame(in: .global).minY
                            } action: { [scroll] new in
                                scroll.insetTopGlobalY = new
                                scroll.insetTopChangedAt = Date().timeIntervalSinceReferenceDate
                            }
                    }
                    .background(Theme.bg.ignoresSafeArea())
            } else {
                VStack(spacing: 12) {
                    ZeronPulse()
                    Text("Opening agent transcript…")
                        .font(Theme.sans(12))
                        .foregroundStyle(Theme.textFaint)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Theme.bg)
            }
        }
        .navigationTitle("Agent")
        .navigationBarTitleDisplayMode(.inline)
        // parentChatId is Route identity (same docId cannot spawn from two
        // parents) and the frozen-blob key `{parent}/{docId}` when we grow
        // past the live-watch MVP.
        .accessibilityIdentifier("subagent.\(parentChatId).\(docId)")
    }
}
