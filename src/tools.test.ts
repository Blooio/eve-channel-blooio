import { describe, expect, it, vi } from "vitest";

import { formatBlooioContextBlock, parseBlooioInboundMessage } from "./inbound.js";
import { blooioInteractiveTool, type BlooioInteractiveToolResult } from "./tools.js";

const QUICK_REPLY = {
  kind: "quick_reply",
  summary_text: "How can we help?",
  items: [
    { id: "billing", title: "Billing" },
    { id: "support", title: "Support" },
  ],
};

function respond(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

function toolContext(attributes: Record<string, string> | null, messages: unknown[] = []) {
  return {
    messages,
    session: { auth: { current: attributes ? { attributes } : null, initiator: null } },
  } as any;
}

async function run(tool: ReturnType<typeof blooioInteractiveTool>, ctx: unknown, interactive = QUICK_REPLY) {
  return (await tool.execute({ interactive }, ctx as any)) as BlooioInteractiveToolResult;
}

describe("blooioInteractiveTool", () => {
  it("sends the interactive object to the chat from session auth and ends the turn", async () => {
    const { calls, fetch } = respond(200, { id: "msg_1", chat_id: "chat_amb", status: "queued" });
    const tool = blooioInteractiveTool({ credentials: { apiKey: "bl_live" }, fetch });
    const result = await run(tool, toolContext({ chat_id: "chat_amb", channel_type: "amb" }));

    expect(result).toEqual({ chatId: "chat_amb", messageId: "msg_1", sent: true });
    expect(calls[0]!.url).toBe("https://api.blooio.com/v4/chats/chat_amb/messages");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ interactive: QUICK_REPLY });
    const endsTurn = tool.endsTurn as (output: BlooioInteractiveToolResult) => boolean;
    expect(endsTurn(result)).toBe(true);
  });

  it("falls back to the latest blooio_context block when auth has no chat id", async () => {
    const { calls, fetch } = respond(200, { id: "msg_2" });
    const inbound = parseBlooioInboundMessage({
      type: "message.received",
      data: { chat_id: "chat_ctx", channel_type: "amb", sender: "urn:mbid:x", text: "hi" },
    })!;
    const messages = [{ role: "user", content: [{ type: "text", text: formatBlooioContextBlock(inbound) }] }];
    const tool = blooioInteractiveTool({ credentials: { apiKey: "bl_live" }, fetch });
    const result = await run(tool, toolContext({ channel: "direct" }, messages));

    expect(result.sent).toBe(true);
    expect(calls[0]!.url).toBe("https://api.blooio.com/v4/chats/chat_ctx/messages");
  });

  it("refuses non-AMB conversations without calling Blooio", async () => {
    const { calls, fetch } = respond(200, {});
    const tool = blooioInteractiveTool({ credentials: { apiKey: "bl_live" }, fetch });
    const result = await run(tool, toolContext({ chat_id: "chat_x", channel_type: "blooio" }));

    expect(result).toMatchObject({ reason: "not_apple_messages_for_business", sent: false });
    expect(calls).toHaveLength(0);
    const endsTurn = tool.endsTurn as (output: BlooioInteractiveToolResult) => boolean;
    expect(endsTurn(result)).toBe(false);
  });

  it("tells the model to use plain text when the device lacks the capability", async () => {
    const { fetch } = respond(422, { error: { code: "amb_capability_unavailable", message: "LIST not supported" } });
    const tool = blooioInteractiveTool({ credentials: { apiKey: "bl_live" }, fetch });
    const result = await run(tool, toolContext({ chat_id: "chat_amb", channel_type: "amb" }));

    expect(result).toMatchObject({ reason: "amb_capability_unavailable", sent: false });
    expect(result.sent === false && result.instructions).toMatch(/plain text/);
  });

  it("stops on a closed chat", async () => {
    const { fetch } = respond(409, { error: { code: "chat_closed", message: "closed" } });
    const tool = blooioInteractiveTool({ credentials: { apiKey: "bl_live" }, fetch });
    const result = await run(tool, toolContext({ chat_id: "chat_amb", channel_type: "amb" }));
    expect(result).toMatchObject({ reason: "chat_closed", sent: false });
  });

  it("throws on unexpected API failures", async () => {
    const { fetch } = respond(500, { error: { code: "internal", message: "boom" } });
    const tool = blooioInteractiveTool({ credentials: { apiKey: "bl_live" }, fetch });
    await expect(run(tool, toolContext({ chat_id: "chat_amb", channel_type: "amb" }))).rejects.toThrow(/status 500/);
  });

  it("publishes the documented interactive schema under an `interactive` property", () => {
    const tool = blooioInteractiveTool();
    const schema = tool.inputSchema as any;
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["interactive"]);
    expect(schema.properties.interactive.oneOf.map((branch: any) => branch.title)).toEqual([
      "quick_reply",
      "list_picker",
      "time_picker",
      "form",
    ]);
  });
});
