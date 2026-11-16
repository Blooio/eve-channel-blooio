import { describe, expect, it, vi } from "vitest";
import type { ChannelEventContext } from "eve/channels";
import { emptySessionView } from "eve/events";

import { blooioChannel, type BlooioEventContext, type BlooioHandle } from "./blooioChannel.js";
import { defaultBlooioAuth, defaultEvents } from "./defaults.js";
import { parseBlooioInboundMessage } from "./inbound.js";

function eventContext(overrides: Partial<BlooioHandle> = {}) {
  const response = async () => ({ ok: true, status: 200, body: null });
  const sendMessage = vi.fn(response);
  const startTyping = vi.fn(response);
  const blooio: BlooioHandle = {
    chatId: "chat_amb", to: "customer", sender: "customer", isGroup: false,
    channelType: "amb", isAppleMessagesForBusiness: true,
    sendMessage, startTyping, stopTyping: response, markRead: response,
    sendInteractive: response, sendRichLink: response, sendInvitation: response,
    getChat: response, supportedInteractiveKinds: async () => [], react: response,
    sendPoll: response, shareContactCard: response, lookupNumber: response,
    contactCapabilities: response, listMessages: response, request: response,
    ...overrides,
  };
  const ctx: ChannelEventContext<BlooioEventContext> = {
    channel: {
      blooio,
      state: {
        chatId: "chat_amb", to: "customer", from: "support", channelType: "amb",
        sender: "customer", isGroup: false, groupId: null, lastMessageId: "msg_1",
      },
    },
    position: { line: 0, index: 0 },
    view: emptySessionView(),
    session: { id: "session_1", auth: { current: null, initiator: null }, turn: { id: "turn_1", sequence: 0 } },
    async getSandbox() { throw new Error("No sandbox in this test"); },
  };
  return { ctx, sendMessage, startTyping };
}

describe("eve 1.x default events", () => {
  it("constructs the channel without obsolete event keys", () => {
    expect(() => blooioChannel()).not.toThrow();
    expect(Object.keys(defaultEvents)).toEqual([
      "turn.started", "content.completed", "turn.settled", "session.ended",
    ]);
  });

  it("delivers completed reply text from event.data through ctx.channel", async () => {
    const { ctx, sendMessage } = eventContext();
    await defaultEvents["content.completed"]!({
      type: "content.completed", scope: { turnId: "turn_1" },
      data: { partId: "part_1", kind: "text", phase: "reply", value: "the answer" },
    }, ctx);
    expect(sendMessage).toHaveBeenCalledWith("the answer");
  });

  const ignoredContent: Parameters<NonNullable<typeof defaultEvents["content.completed"]>>[0]["data"][] = [
    { partId: "p", kind: "text", phase: "narration", value: "working" },
    { partId: "p", kind: "reasoning", phase: "reply", value: "private reasoning" },
    { partId: "p", kind: "file", phase: "reply", value: { url: "https://example.com/a.png" } },
    { partId: "p", kind: "result", phase: "reply", value: { answer: 42 } },
    { partId: "p", kind: "text", phase: "reply", value: "" },
    { partId: "p", kind: "text", phase: "reply", value: null },
    { partId: "p", kind: "text", phase: "future", value: "unknown phase" },
  ];
  it.each(ignoredContent)("does not deliver non-reply or non-text content: %j", async (data) => {
    const { ctx, sendMessage } = eventContext();
    await defaultEvents["content.completed"]!({ type: "content.completed", data }, ctx);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("shows typing for a bound Apple Messages for Business chat", async () => {
    const { ctx, startTyping } = eventContext();
    await defaultEvents["turn.started"]!({ type: "turn.started", data: { turnId: "t", follows: null, cause: { deliveryId: "d" } } }, ctx);
    expect(startTyping).toHaveBeenCalledTimes(1);
  });

  it.each([{ isAppleMessagesForBusiness: false }, { chatId: undefined }])("skips typing when unavailable: %j", async (override) => {
    const { ctx, startTyping } = eventContext(override);
    await defaultEvents["turn.started"]!({ type: "turn.started", data: { turnId: "t", follows: null, cause: { deliveryId: "d" } } }, ctx);
    expect(startTyping).not.toHaveBeenCalled();
  });

  it("does not fail a turn when the cosmetic typing indicator fails", async () => {
    const { ctx } = eventContext({ startTyping: async () => { throw new Error("offline"); } });
    await expect(defaultEvents["turn.started"]!({ type: "turn.started", data: { turnId: "t", follows: null, cause: { deliveryId: "d" } } }, ctx)).resolves.toBeUndefined();
  });

  it("reports failed turns and sessions using their nested errors", async () => {
    const { ctx, sendMessage } = eventContext();
    const error = { code: "TEST", message: "test failure" };
    await defaultEvents["turn.settled"]!({ type: "turn.settled", data: { turnId: "t", outcome: "failed", error } }, ctx);
    await defaultEvents["session.ended"]!({ type: "session.ended", data: { outcome: "failed", error } }, ctx);
    expect(sendMessage.mock.calls).toEqual([
      ["I hit an error while handling your request: test failure.\n\nPlease try again, rephrase, or reach out if it keeps failing."],
      ["This session could not recover from an error: test failure.\n\nSend a new message to continue."],
    ]);
  });

  it("ignores successful and cancelled endings, including session-failure cancellation", async () => {
    const { ctx, sendMessage } = eventContext();
    for (const outcome of ["completed", "cancelled"] as const) {
      await defaultEvents["turn.settled"]!({ type: "turn.settled", data: { turnId: "t", outcome } }, ctx);
    }
    await defaultEvents["session.ended"]!({ type: "session.ended", data: { outcome: "completed" } }, ctx);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("retains webhook principal and routing attributes used by tools and approval policies", () => {
    const message = parseBlooioInboundMessage({ type: "message.received", data: {
      chat_id: "chat_amb", sender: "customer", recipient: "support", channel_type: "amb",
    } });
    expect(message).not.toBeNull();
    expect(defaultBlooioAuth(message!)).toEqual({
      principalId: "blooio:customer", principalType: "user", authenticator: "blooio-webhook", issuer: "blooio",
      attributes: { channel: "direct", chat_id: "chat_amb", from: "customer", to: "support", channel_type: "amb" },
    });
  });
});
