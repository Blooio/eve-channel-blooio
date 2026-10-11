import { describe, expect, it, vi } from "vitest";

import { blooioChannel } from "./blooioChannel.js";
import { defaultEvents } from "./defaults.js";
import { signBlooioPayload } from "./verify.js";

const SECRET = "whsec_test_secret";

function getPostHandler(channel: ReturnType<typeof blooioChannel>) {
  const route = channel.routes.find(
    (r) => (r as { method?: string }).method === "POST",
  ) as { handler: (req: Request, args: unknown) => Promise<Response> };
  return route.handler;
}

/**
 * Builds the route-handler args eve 0.43+ passes as the second argument. The
 * inbound route creates sessions via `from(address).send(message, options)`,
 * so `from` returns a stub bound to the shared `send` spy.
 */
function mockRouteArgs() {
  const send = vi.fn(async () => ({ id: "session_1" }));
  const from = vi.fn((_address: string) => ({ send }));
  const tasks: Promise<unknown>[] = [];
  const waitUntil = (task: Promise<unknown>) => {
    tasks.push(task);
  };
  const settle = () => Promise.all(tasks);
  return { from, send, settle, waitUntil };
}

/** Build a signed native v4 `message.received` webhook request. */
function signedWebhook(data: Record<string, unknown>, type = "message.received"): Request {
  const body = JSON.stringify({
    id: "evt_1",
    type,
    created_at: Date.now(),
    organization_id: "org_1",
    data,
  });
  const t = Math.floor(Date.now() / 1000);
  return new Request("https://example.com/eve/v1/blooio", {
    method: "POST",
    headers: { "x-blooio-signature": `t=${t},v1=${signBlooioPayload(SECRET, t, body)}` },
    body,
  });
}

describe("blooioChannel inbound route", () => {
  it("dispatches a verified message.received webhook keyed by chat id", async () => {
    const channel = blooioChannel({ credentials: { apiKey: "bl_live", webhookSecret: SECRET } });
    const handler = getPostHandler(channel);
    const { from, send, settle, waitUntil } = mockRouteArgs();

    const res = await handler(
      signedWebhook({
        message_id: "msg_1",
        chat_id: "chat_abc",
        channel_type: "blooio",
        sender: "+15551234567",
        recipient: "+15557654321",
        text: "hello",
      }),
      { from, waitUntil },
    );
    await settle();

    expect(res.status).toBe(200);
    expect(from).toHaveBeenCalledWith("chat_abc");
    expect(send).toHaveBeenCalledTimes(1);
    const [message, options] = send.mock.calls[0] as unknown as [any, any];
    expect(message).toBe("hello");
    expect(options.state.chatId).toBe("chat_abc");
    expect(options.state.channelType).toBe("blooio");
  });

  it("forwards inbound attachments as multimodal file parts", async () => {
    const channel = blooioChannel({ credentials: { apiKey: "bl_live", webhookSecret: SECRET } });
    const handler = getPostHandler(channel);
    const { from, send, settle, waitUntil } = mockRouteArgs();

    await handler(
      signedWebhook({
        message_id: "msg_2",
        chat_id: "chat_abc",
        sender: "+15551234567",
        text: "look at this",
        attachments: [
          { url: "https://bucket.blooio.com/api-attachments/abc.png", media_type: "image/png" },
        ],
      }),
      { from, waitUntil },
    );
    await settle();

    const [message] = send.mock.calls[0] as unknown as [any, any];
    expect(Array.isArray(message)).toBe(true);
    expect(message[0]).toEqual({ type: "text", text: "look at this" });
    expect(message[1].type).toBe("file");
    expect(message[1].mediaType).toBe("image/png");
    expect(String(message[1].data)).toBe("https://bucket.blooio.com/api-attachments/abc.png");
  });

  it("infers the media type from the URL when none is provided", async () => {
    const channel = blooioChannel({ credentials: { apiKey: "bl_live", webhookSecret: SECRET } });
    const handler = getPostHandler(channel);
    const { from, send, settle, waitUntil } = mockRouteArgs();

    await handler(
      signedWebhook({
        chat_id: "chat_abc",
        sender: "+15551234567",
        text: "",
        attachments: [{ url: "https://bucket.blooio.com/api-attachments/clip.mov" }],
      }),
      { from, waitUntil },
    );
    await settle();

    const [message] = send.mock.calls[0] as unknown as [any, any];
    expect(Array.isArray(message)).toBe(true);
    expect(message).toHaveLength(1);
    expect(message[0].type).toBe("file");
    expect(message[0].mediaType).toBe("video/quicktime");
  });

  it("rejects an unsigned webhook", async () => {
    const channel = blooioChannel({ credentials: { apiKey: "bl_live", webhookSecret: SECRET } });
    const handler = getPostHandler(channel);
    const { from } = mockRouteArgs();
    const res = await handler(
      new Request("https://example.com/eve/v1/blooio", {
        method: "POST",
        body: JSON.stringify({ type: "message.received", data: { chat_id: "chat_x" } }),
      }),
      { from, waitUntil: () => {} },
    );
    expect(res.status).toBe(401);
    expect(from).not.toHaveBeenCalled();
  });

  it("acks non-received events without dispatching", async () => {
    const channel = blooioChannel({ credentials: { apiKey: "bl_live", webhookSecret: SECRET } });
    const handler = getPostHandler(channel);
    const { from } = mockRouteArgs();
    const res = await handler(
      signedWebhook({ message_id: "msg_1", chat_id: "chat_x" }, "message.delivered"),
      { from, waitUntil: () => {} },
    );
    expect(res.status).toBe(200);
    expect(from).not.toHaveBeenCalled();
  });

  it("honors an allowFrom list", async () => {
    const channel = blooioChannel({
      credentials: { apiKey: "bl_live", webhookSecret: SECRET },
      allowFrom: ["+15559999999"],
    });
    const handler = getPostHandler(channel);
    const { from } = mockRouteArgs();
    const res = await handler(
      signedWebhook({ chat_id: "chat_x", sender: "+15551234567", text: "hi" }),
      { from, waitUntil: () => {} },
    );
    expect(res.status).toBe(403);
    expect(from).not.toHaveBeenCalled();
  });
});

describe("inbound admission", () => {
  const webhook = () =>
    signedWebhook({ chat_id: "chat_abc", message_id: "msg_1", sender: "+15551112222", text: "hi" });

  it("acknowledges only after the session accepts the message", async () => {
    const channel = blooioChannel({ credentials: { apiKey: "bl_live", webhookSecret: SECRET } });
    const order: string[] = [];
    const send = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("accepted");
      return { id: "session_1" };
    });
    const res = await getPostHandler(channel)(webhook(), { from: () => ({ send }), waitUntil: () => {} });
    order.push("acknowledged");

    expect(res.status).toBe(200);
    expect(order).toEqual(["accepted", "acknowledged"]);
  });

  it("fails the webhook when enqueue fails so Blooio retries it", async () => {
    const channel = blooioChannel({ credentials: { apiKey: "bl_live", webhookSecret: SECRET } });
    const pending: Promise<unknown>[] = [];
    const send = vi.fn(async () => {
      throw new Error("enqueue unavailable");
    });
    await expect(
      getPostHandler(channel)(webhook(), { from: () => ({ send }), waitUntil: (p: Promise<unknown>) => pending.push(p) }),
    ).rejects.toThrow("enqueue unavailable");
    expect(send).toHaveBeenCalledTimes(1);
    expect(pending).toHaveLength(0);
  });

  it("fails the webhook when onMessage throws", async () => {
    const channel = blooioChannel({
      credentials: { apiKey: "bl_live", webhookSecret: SECRET },
      onMessage() {
        throw new Error("auth lookup failed");
      },
    });
    const { from, send } = mockRouteArgs();
    await expect(getPostHandler(channel)(webhook(), { from, waitUntil: () => {} })).rejects.toThrow(
      "auth lookup failed",
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("does not let a failed read receipt block or fail admission", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof globalThis.fetch;
    const channel = blooioChannel({
      credentials: { apiKey: "bl_live", webhookSecret: SECRET },
      fetch,
      markReadOnReceive: true,
    });
    const { from, send, settle, waitUntil } = mockRouteArgs();
    const res = await getPostHandler(channel)(webhook(), { from, waitUntil });
    await settle();
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("default message.completed handler", () => {
  it("sends the completed assistant message", async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, status: 200, body: null }));
    const channel = { blooio: { sendMessage } } as any;
    await defaultEvents["message.completed"]!(
      { finishReason: "stop", message: "the answer", sequence: 0, stepIndex: 0, turnId: "t" } as any,
      channel,
      {} as any,
    );
    expect(sendMessage).toHaveBeenCalledWith("the answer");
  });

  it("skips tool-call boundaries", async () => {
    const sendMessage = vi.fn();
    const channel = { blooio: { sendMessage } } as any;
    await defaultEvents["message.completed"]!(
      { finishReason: "tool-calls", message: null, sequence: 0, stepIndex: 0, turnId: "t" } as any,
      channel,
      {} as any,
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("default turn.started handler", () => {
  it("shows a typing indicator on Apple Messages for Business", async () => {
    const startTyping = vi.fn(async () => ({ ok: true, status: 200, body: null }));
    const channel = { blooio: { chatId: "chat_amb", isAppleMessagesForBusiness: true, startTyping } } as any;
    await defaultEvents["turn.started"]!({} as any, channel, {} as any);
    expect(startTyping).toHaveBeenCalledTimes(1);
  });

  it("does nothing on other channel types", async () => {
    const startTyping = vi.fn();
    const channel = { blooio: { chatId: "chat_x", isAppleMessagesForBusiness: false, startTyping } } as any;
    await defaultEvents["turn.started"]!({} as any, channel, {} as any);
    expect(startTyping).not.toHaveBeenCalled();
  });
});

describe("Apple Messages for Business conversations", () => {
  function ambFetch(chat: Record<string, unknown> = {}) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ data: { id: "chat_amb", ...chat } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    return { calls, fetch };
  }

  async function captureAmbHandle(fetch: typeof globalThis.fetch) {
    let handle: any;
    const channel = blooioChannel({
      credentials: { apiKey: "bl_live", webhookSecret: SECRET },
      fetch,
      onMessage(ctx) {
        handle = ctx.blooio;
        return null;
      },
    });
    const { from, settle, waitUntil } = mockRouteArgs();
    await getPostHandler(channel)(
      signedWebhook({
        chat_id: "chat_amb",
        channel_type: "amb",
        sender: "urn:mbid:opaque",
        recipient: "support",
        text: "hi",
      }),
      { from, waitUntil },
    );
    await settle();
    return handle;
  }

  it("exposes AMB conversation details on the handle", async () => {
    const handle = await captureAmbHandle(ambFetch().fetch);
    expect(handle.isAppleMessagesForBusiness).toBe(true);
    expect(handle.channelType).toBe("amb");
    expect(handle.chatId).toBe("chat_amb");
  });

  it("sends interactive messages and rich links to the bound chat", async () => {
    const { calls, fetch } = ambFetch();
    const handle = await captureAmbHandle(fetch);
    await handle.sendInteractive({ kind: "quick_reply", summary_text: "Pick one", items: [{ id: "a", title: "A" }] });
    await handle.sendRichLink("https://blooio.com", "Blooio");
    expect(calls[0]!.url).toBe("https://api.blooio.com/v4/chats/chat_amb/messages");
    expect(JSON.parse(calls[0]!.init.body as string).interactive.kind).toBe("quick_reply");
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({
      rich_link: { title: "Blooio", url: "https://blooio.com" },
    });
  });

  it("reads supported interactive kinds from the chat", async () => {
    const { calls, fetch } = ambFetch({ supported_interactive_kinds: ["quick_reply", "list_picker"] });
    const handle = await captureAmbHandle(fetch);
    await expect(handle.supportedInteractiveKinds()).resolves.toEqual(["quick_reply", "list_picker"]);
    expect(calls[0]!.url).toBe("https://api.blooio.com/v4/chats/chat_amb");
  });

  it("sends invitations from the conversation's AMB alias", async () => {
    const { calls, fetch } = ambFetch();
    const handle = await captureAmbHandle(fetch);
    await handle.sendInvitation({ to: "tel:+15551234567", invitation: { template_id: "tmpl_1" } });
    expect(calls[0]!.url).toBe("https://api.blooio.com/v4/messages");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      from: "support",
      invitation: { template_id: "tmpl_1" },
      to: "tel:+15551234567",
    });
  });

  it("does not look up the opaque AMB sender as a phone number", async () => {
    const handle = await captureAmbHandle(ambFetch().fetch);
    expect(() => handle.lookupNumber()).toThrow(/requires a number/);
  });
});
