import Foundation
import Testing
@testable import OpenClaw

@Suite struct TalkModeManagerParseTests {
    @Test func contentBlocksWithText() {
        let messages: [[String: Any]] = [
            [
                "role": "assistant",
                "content": [["type": "text", "text": "hello"]],
            ],
        ]
        #expect(
            TalkModeManager.parseAssistantText(from: messages) == "hello")
    }

    @Test func contentAsPlainString() {
        let messages: [[String: Any]] = [
            ["role": "assistant", "content": "plain text"],
        ]
        #expect(
            TalkModeManager.parseAssistantText(from: messages)
                == "plain text")
    }

    @Test func multipleContentBlocks() {
        let messages: [[String: Any]] = [
            [
                "role": "assistant",
                "content": [
                    ["type": "text", "text": "line one"],
                    ["type": "text", "text": "line two"],
                ],
            ],
        ]
        #expect(
            TalkModeManager.parseAssistantText(from: messages)
                == "line one\nline two")
    }

    @Test func timestampFilterSkipsOld() {
        let since = 1_700_000_000.0
        let oldTs = 1_699_999_998.0 * 1000
        let messages: [[String: Any]] = [
            [
                "role": "assistant",
                "content": "old reply",
                "timestamp": oldTs,
            ],
        ]
        #expect(
            TalkModeManager.parseAssistantText(
                from: messages, since: since) == nil)
    }

    @Test func timestampFilterAcceptsNew() {
        let since = 1_700_000_000.0
        let newTs = since * 1000
        let messages: [[String: Any]] = [
            [
                "role": "assistant",
                "content": "new reply",
                "timestamp": newTs,
            ],
        ]
        #expect(
            TalkModeManager.parseAssistantText(
                from: messages, since: since) == "new reply")
    }

    @Test func emptyContentReturnsNil() {
        let messages: [[String: Any]] = [
            [
                "role": "assistant",
                "content": [["type": "text", "text": ""]],
            ],
        ]
        #expect(
            TalkModeManager.parseAssistantText(from: messages) == nil)
    }

    @Test func noAssistantMessagesReturnsNil() {
        let messages: [[String: Any]] = [
            ["role": "user", "content": "hello"],
            ["role": "system", "content": "you are a bot"],
        ]
        #expect(
            TalkModeManager.parseAssistantText(from: messages) == nil)
    }

    @Test func newestAssistantWins() {
        let messages: [[String: Any]] = [
            ["role": "assistant", "content": "old answer"],
            ["role": "user", "content": "follow up"],
            ["role": "assistant", "content": "new answer"],
        ]
        #expect(
            TalkModeManager.parseAssistantText(from: messages)
                == "new answer")
    }

    @Test func extractsTextFromChatEventMessageDict() {
        // Simulates the shape of ChatEvent.message?.value
        // as sent by emitChatFinal in server-chat.ts
        let messageDict: [String: Any] = [
            "role": "assistant",
            "content": [["type": "text", "text": "event reply"]],
            "timestamp": Date().timeIntervalSince1970 * 1000,
        ]
        #expect(
            TalkModeManager.parseAssistantText(from: [messageDict])
                == "event reply")
    }

    @Test func nilMessageDictReturnsNil() {
        let empty: [[String: Any]] = []
        #expect(
            TalkModeManager.parseAssistantText(from: empty) == nil)
    }
}
