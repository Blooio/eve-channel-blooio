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
