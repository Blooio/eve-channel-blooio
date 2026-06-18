import { describe, expect, it } from "vitest";

import {
  formatBlooioContextBlock,
  parseBlooioInboundMessage,
  resolveAttachmentMediaType,
} from "./inbound.js";

describe("parseBlooioInboundMessage", () => {
  it("parses a 1:1 inbound message", () => {
    const message = parseBlooioInboundMessage({
      event: "message.received",
      message_id: "msg_123",
      sender: "+15551234567",
      internal_id: "+15557654321",
      protocol: "imessage",
      text: "hello",
      timestamp: 1000,
    });
    expect(message).not.toBeNull();
    expect(message?.chatId).toBe("+15551234567");
    expect(message?.sender).toBe("+15551234567");
    expect(message?.internalId).toBe("+15557654321");
    expect(message?.isGroup).toBe(false);
    expect(message?.text).toBe("hello");
    expect(message?.messageId).toBe("msg_123");
  });

  it("routes group messages to the group id", () => {
    const message = parseBlooioInboundMessage({
      event: "message.received",
      is_group: true,
      group_id: "grp_abc",
      group_name: "Team",
      sender: "+15551234567",
      text: "hi all",
    });
    expect(message?.isGroup).toBe(true);
    expect(message?.chatId).toBe("grp_abc");
    expect(message?.groupName).toBe("Team");
  });

  it("falls back to external_id when sender is absent", () => {
    const message = parseBlooioInboundMessage({
      event: "message.received",
      external_id: "+15550001111",
      text: "yo",
    });
    expect(message?.sender).toBe("+15550001111");
    expect(message?.chatId).toBe("+15550001111");
  });

  it("normalizes attachments and reply metadata", () => {
    const message = parseBlooioInboundMessage({
      event: "message.received",
      sender: "+15551234567",
      attachments: [
        "https://cdn/x.jpg",
        { url: "https://cdn/y.png", file_name: "y.png", mime_type: "image/png", size: 42 },
      ],
      reply_to: { message_id: "msg_parent", part_index: 0 },
    });
    expect(message?.attachments).toHaveLength(2);
    expect(message?.attachments[0]?.url).toBe("https://cdn/x.jpg");
    expect(message?.attachments[1]?.name).toBe("y.png");
    expect(message?.attachments[1]?.mimeType).toBe("image/png");
    expect(message?.attachments[1]?.size).toBe(42);
    expect(message?.replyTo?.messageId).toBe("msg_parent");
  });

  it("ignores non-received events", () => {
    expect(parseBlooioInboundMessage({ event: "message.delivered" })).toBeNull();
    expect(parseBlooioInboundMessage({ event: "message.sent" })).toBeNull();
    expect(parseBlooioInboundMessage(null)).toBeNull();
    expect(parseBlooioInboundMessage("nope")).toBeNull();
  });

  it("drops received events with no addressable target", () => {
    expect(parseBlooioInboundMessage({ event: "message.received", text: "x" })).toBeNull();
  });
});

describe("resolveAttachmentMediaType", () => {
  it("prefers the explicit mime type", () => {
    expect(resolveAttachmentMediaType({ url: "https://x/y.bin", mimeType: "image/png" })).toBe(
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
    const message = parseBlooioInboundMessage({
      event: "message.received",
      message_id: "msg_1",
      sender: "+15551234567",
      internal_id: "+15557654321",
      protocol: "imessage",
      text: "hello",
    });
    const block = formatBlooioContextBlock(message!);
    expect(block).toContain("<blooio_context>");
    expect(block).toContain("from: +15551234567");
    expect(block).toContain("message_id: msg_1");
    expect(block).toContain("</blooio_context>");
  });
});
