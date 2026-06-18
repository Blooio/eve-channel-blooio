import { describe, expect, it, vi } from "vitest";

import {
  blooioContinuationToken,
  reactBlooioMessage,
  sendBlooioMessage,
  startBlooioTyping,
} from "./api.js";

function jsonFetch(): { fetch: typeof globalThis.fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fetchMock, calls };
}

describe("blooioContinuationToken", () => {
  it("joins internalId and chatId", () => {
    expect(blooioContinuationToken("+1555", "+1666")).toBe("+1555:+1666");
    expect(blooioContinuationToken(undefined, "grp_x")).toBe(":grp_x");
  });
});

describe("sendBlooioMessage", () => {
  it("posts to the chat messages endpoint with a bearer token", async () => {
    const { fetch, calls } = jsonFetch();
    const res = await sendBlooioMessage({
      credentials: { apiKey: "sk_test" },
      fetch,
      chatId: "+15551234567",
      text: "hi",
      attachments: ["https://cdn/x.jpg", { url: "https://cdn/y.png", name: "y" }],
      idempotencyKey: "idem-1",
    });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://backend.blooio.com/v2/api/chats/%2B15551234567/messages",
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk_test");
    expect(headers["Idempotency-Key"]).toBe("idem-1");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.text).toBe("hi");
    expect(body.attachments).toEqual([
      "https://cdn/x.jpg",
      { url: "https://cdn/y.png", name: "y" },
    ]);
  });

  it("throws without text or attachments", async () => {
    const { fetch } = jsonFetch();
    await expect(
      sendBlooioMessage({ credentials: { apiKey: "sk" }, fetch, chatId: "+1" }),
    ).rejects.toThrow(/text or at least one attachment/);
  });
});

describe("reactBlooioMessage", () => {
  it("posts a reaction to the reactions endpoint", async () => {
    const { fetch, calls } = jsonFetch();
    await reactBlooioMessage({
      credentials: { apiKey: "sk" },
      fetch,
      chatId: "+15551234567",
      messageId: "msg_1",
      reaction: "+love",
    });
    expect(calls[0]!.url).toBe(
      "https://backend.blooio.com/v2/api/chats/%2B15551234567/messages/msg_1/reactions",
    );
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ reaction: "+love" });
  });
});

describe("startBlooioTyping", () => {
  it("posts to the typing endpoint", async () => {
    const { fetch, calls } = jsonFetch();
    await startBlooioTyping({ credentials: { apiKey: "sk" }, fetch, chatId: "+15551234567" });
    expect(calls[0]!.url).toBe("https://backend.blooio.com/v2/api/chats/%2B15551234567/typing");
    expect(calls[0]!.init.method).toBe("POST");
  });
});
