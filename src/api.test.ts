import { describe, expect, it, vi } from "vitest";

import {
  blooioContinuationToken,
  lookupBlooioNumber,
  reactBlooioMessage,
  sendBlooioMessage,
  sendBlooioToRecipient,
  startBlooioTyping,
} from "./api.js";

const BASE = "https://api.blooio.com/v4";

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
  it("returns the chat id verbatim", () => {
    expect(blooioContinuationToken("chat_abc")).toBe("chat_abc");
  });
});

describe("sendBlooioMessage", () => {
  it("posts to the chat messages endpoint with a bearer token", async () => {
    const { fetch, calls } = jsonFetch();
    const res = await sendBlooioMessage({
      credentials: { apiKey: "bl_live_test" },
      fetch,
      chatId: "chat_abc",
      text: "hi",
      attachments: ["https://cdn/x.jpg", "https://cdn/y.png"],
      idempotencyKey: "idem-1",
    });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/chats/chat_abc/messages`);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer bl_live_test");
    expect(headers["Idempotency-Key"]).toBe("idem-1");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toEqual({ text: "hi", attachments: ["https://cdn/x.jpg", "https://cdn/y.png"] });
  });

  it("throws without text or attachments", async () => {
    const { fetch } = jsonFetch();
    await expect(
      sendBlooioMessage({ credentials: { apiKey: "bl_live" }, fetch, chatId: "chat_x" }),
    ).rejects.toThrow(/text or at least one attachment/);
  });
});

describe("sendBlooioToRecipient", () => {
  it("defaults routing to the blooio channel type", async () => {
    const { fetch, calls } = jsonFetch();
    await sendBlooioToRecipient({
      credentials: { apiKey: "bl_live" },
      fetch,
      to: "+15551234567",
      text: "hello",
    });
    expect(calls[0]!.url).toBe(`${BASE}/messages`);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      text: "hello",
      to: "+15551234567",
      channel_type: "blooio",
    });
  });

  it("uses an explicit sender instead of channel routing", async () => {
    const { fetch, calls } = jsonFetch();
    await sendBlooioToRecipient({
      credentials: { apiKey: "bl_live" },
      fetch,
      to: "+15551234567",
      from: "+18582849901",
      text: "hello",
    });
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.from).toBe("+18582849901");
    expect(body.channel_type).toBeUndefined();
  });
});

describe("reactBlooioMessage", () => {
  it("posts a reaction to the reactions endpoint", async () => {
    const { fetch, calls } = jsonFetch();
    await reactBlooioMessage({
      credentials: { apiKey: "bl_live" },
      fetch,
      chatId: "chat_abc",
      messageId: "msg_1",
      reaction: "+love",
    });
    expect(calls[0]!.url).toBe(`${BASE}/chats/chat_abc/messages/msg_1/reactions`);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ reaction: "+love" });
  });
});

describe("startBlooioTyping", () => {
  it("posts a started state to the typing endpoint", async () => {
    const { fetch, calls } = jsonFetch();
    await startBlooioTyping({ credentials: { apiKey: "bl_live" }, fetch, chatId: "chat_abc" });
    expect(calls[0]!.url).toBe(`${BASE}/chats/chat_abc/typing`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ state: "started" });
  });
});

describe("lookupBlooioNumber", () => {
  it("gets the phone-number lookup endpoint with the number query", async () => {
    const { fetch, calls } = jsonFetch();
    await lookupBlooioNumber({ credentials: { apiKey: "bl_live" }, fetch, number: "+15551234567" });
    expect(calls[0]!.url).toBe(`${BASE}/phone-numbers/lookup?number=%2B15551234567`);
    expect(calls[0]!.init.method).toBe("GET");
  });
});
