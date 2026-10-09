import { describe, expect, it } from "vitest";

import {
  formatBlooioContextBlock,
  parseBlooioInboundMessage,
  resolveAttachmentMediaType,
} from "./inbound.js";

/** A minimal native v4 `message.received` webhook envelope. */
function envelope(data: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    id: "evt_1",
    type: "message.received",
    created_at: 1000,
    organization_id: "org_1",
    data,
    ...extra,
  };
}

describe("parseBlooioInboundMessage", () => {
  it("parses a 1:1 inbound message from the v4 envelope", () => {
    const message = parseBlooioInboundMessage(
      envelope({
        message_id: "msg_123",
        chat_id: "chat_abc",
        channel_id: "ch_1",
        channel_type: "blooio",
        direction: "inbound",
        kind: "received",
        protocol: "imessage",
        text: "hello",
        sender: "+15551234567",
        recipient: "+15557654321",
        contact: { identifier: "+15551234567" },
      }),
    );
    expect(message).not.toBeNull();
    expect(message?.chatId).toBe("chat_abc");
    expect(message?.sender).toBe("+15551234567");
    expect(message?.recipient).toBe("+15557654321");
    expect(message?.channelType).toBe("blooio");
    expect(message?.isGroup).toBe(false);
    expect(message?.text).toBe("hello");
    expect(message?.messageId).toBe("msg_123");
    expect(message?.eventId).toBe("evt_1");
    expect(message?.receivedAt).toBe(1000);
  });

  it("marks group messages via group data", () => {
    const message = parseBlooioInboundMessage(
      envelope({
        chat_id: "chat_grp",
        sender: "+15551234567",
        text: "hi all",
        group: { group_id: "grp_abc", name: "Team" },
      }),
    );
    expect(message?.isGroup).toBe(true);
    expect(message?.chatId).toBe("chat_grp");
    expect(message?.groupId).toBe("grp_abc");
    expect(message?.groupName).toBe("Team");
  });

  it("falls back to the contact identifier when sender is absent", () => {
    const message = parseBlooioInboundMessage(
      envelope({ chat_id: "chat_x", contact: { identifier: "+15550001111" }, text: "yo" }),
    );
    expect(message?.sender).toBe("+15550001111");
  });

  it("normalizes v4 attachments (url/media_type/size/caption)", () => {
    const message = parseBlooioInboundMessage(
      envelope({
        chat_id: "chat_x",
        sender: "+15551234567",
        attachments: [
          "https://bucket/x.jpg",
          { url: "https://bucket/y.png", media_type: "image/png", size: 42, caption: "hey" },
        ],
      }),
    );
    expect(message?.attachments).toHaveLength(2);
    expect(message?.attachments[0]?.url).toBe("https://bucket/x.jpg");
    expect(message?.attachments[1]?.mediaType).toBe("image/png");
    expect(message?.attachments[1]?.size).toBe(42);
    expect(message?.attachments[1]?.caption).toBe("hey");
  });

  it("ignores non-received events", () => {
    expect(parseBlooioInboundMessage(envelope({ chat_id: "c" }, { type: "message.delivered" }))).toBeNull();
    expect(parseBlooioInboundMessage(envelope({ chat_id: "c" }, { type: "typing.started" }))).toBeNull();
    expect(parseBlooioInboundMessage(null)).toBeNull();
    expect(parseBlooioInboundMessage("nope")).toBeNull();
  });

  it("drops received events with no chat id", () => {
    expect(parseBlooioInboundMessage(envelope({ text: "x", sender: "+1" }))).toBeNull();
  });
});

describe("resolveAttachmentMediaType", () => {
  it("prefers the explicit media type", () => {
    expect(resolveAttachmentMediaType({ url: "https://x/y.bin", mediaType: "image/png" })).toBe(
      "image/png",
    );
  });

  it("infers from the URL extension", () => {
    expect(resolveAttachmentMediaType({ url: "https://x/y.jpg" })).toBe("image/jpeg");
    expect(resolveAttachmentMediaType({ url: "https://x/y.mov?token=1" })).toBe("video/quicktime");
    expect(resolveAttachmentMediaType({ url: "https://x/y.pdf" })).toBe("application/pdf");
  });

  it("falls back to octet-stream", () => {
    expect(resolveAttachmentMediaType({ url: "https://x/y" })).toBe("application/octet-stream");
    expect(resolveAttachmentMediaType({})).toBe("application/octet-stream");
  });
});

describe("formatBlooioContextBlock", () => {
  it("renders a deterministic context block", () => {
    const message = parseBlooioInboundMessage(
      envelope({
        message_id: "msg_1",
        chat_id: "chat_abc",
        channel_type: "blooio",
        protocol: "imessage",
        sender: "+15551234567",
        recipient: "+15557654321",
        text: "hello",
      }),
    );
    const block = formatBlooioContextBlock(message!);
    expect(block).toContain("<blooio_context>");
    expect(block).toContain("from: +15551234567");
    expect(block).toContain("chat_id: chat_abc");
    expect(block).toContain("message_id: msg_1");
    expect(block).toContain("response_medium: imessage");
    expect(block).toContain("</blooio_context>");
  });

  it("marks Apple Messages for Business conversations and surfaces interactive replies", () => {
    const message = parseBlooioInboundMessage(
      envelope({
        message_id: "msg_2",
        chat_id: "chat_amb",
        channel_type: "amb",
        sender: "urn:mbid:opaque",
        recipient: "support",
        text: "Haircut",
        interactive: { role: "reply", kind: "list_picker", chosen: ["Haircut"], request_identifier: "svc-1" },
      }),
    );
    const block = formatBlooioContextBlock(message!);
    expect(block).toContain("response_medium: apple_messages_for_business");
    expect(block).toContain("channel_type: amb");
    expect(block).toContain("interactive_reply: list_picker");
    expect(block).toContain("interactive_chosen: Haircut");
    expect(block).toContain("interactive_request_identifier: svc-1");
  });
});

describe("Apple Messages for Business interactive replies", () => {
  it("parses a form reply with per-page responses", () => {
    const message = parseBlooioInboundMessage(
      envelope({
        chat_id: "chat_amb",
        channel_type: "amb",
        sender: "urn:mbid:opaque",
        text: "J. Appleseed, jappleseed@example.com",
        interactive: {
          role: "reply",
          kind: "form",
          chosen: ["J. Appleseed", "jappleseed@example.com"],
          responses: [{ page_identifier: "details", answers: [{ identifier: "name", value: "J. Appleseed" }] }],
        },
      }),
    );
    expect(message?.interactiveReply).toEqual({
      chosen: ["J. Appleseed", "jappleseed@example.com"],
      kind: "form",
      label: undefined,
      requestIdentifier: undefined,
      responses: [{ page_identifier: "details", answers: [{ identifier: "name", value: "J. Appleseed" }] }],
    });
  });

  it("reads the reply from metadata.interactive", () => {
    const message = parseBlooioInboundMessage(
      envelope({
        chat_id: "chat_amb",
        channel_type: "amb",
        text: "Support",
        metadata: { interactive: { role: "reply", kind: "quick_reply", chosen: ["Support"] } },
      }),
    );
    expect(message?.interactiveReply?.kind).toBe("quick_reply");
    expect(message?.interactiveReply?.chosen).toEqual(["Support"]);
  });

  it("ignores outbound interactive prompts", () => {
    const message = parseBlooioInboundMessage(
      envelope({ chat_id: "chat_amb", channel_type: "amb", interactive: { role: "prompt", kind: "quick_reply" } }),
    );
    expect(message?.interactive).toBeDefined();
    expect(message?.interactiveReply).toBeUndefined();
  });
});
