/**
 * Agent tools for the Blooio channel. Import from `eve-channel-blooio/tools`
 * and default-export from a file under `agent/tools/`.
 */
import type { ModelMessage } from "ai";
import { defineTool } from "eve/tools";

import { AMB_INTERACTIVE_TOOL_INPUT_SCHEMA } from "./ambInteractiveSchema.js";
import {
  sendBlooioMessage,
  type BlooioCredentials,
  type BlooioFetch,
  type BlooioInteractive,
} from "./api.js";

/** Options for {@link blooioInteractiveTool}. */
export interface BlooioInteractiveToolConfig {
  readonly credentials?: BlooioCredentials;
  /** Override the API base URL. Falls back to `BLOOIO_BASE_URL`, then the public default. */
  readonly baseUrl?: string;
  readonly fetch?: BlooioFetch;
  /** Replaces the default tool description shown to the model. */
  readonly description?: string;
}

/** Result returned to the model by {@link blooioInteractiveTool}. */
export type BlooioInteractiveToolResult =
  | { readonly sent: true; readonly messageId: string | undefined; readonly chatId: string }
  | { readonly sent: false; readonly reason: string; readonly instructions: string };

const DEFAULT_DESCRIPTION = [
  "Send an Apple Messages for Business interactive message to the customer in the current conversation:",
  "a quick reply (2-10 short buttons), a list picker, a time picker, or a multi-page form.",
  "Use it only when the conversation's blooio_context shows channel_type: amb, and when tapping is easier",
  "than typing. Choose exactly one kind and fill only that kind's fields. quick_reply must not include",
  "received_message or reply_message. time_picker startTime is ISO-8601 and duration is in seconds.",
  "Keep option, row, and section titles short. Sending ends your turn; the customer's choice arrives as",
  "their next message with interactive_reply and interactive_chosen in blooio_context.",
].join(" ");

const PLAIN_TEXT_INSTRUCTIONS = "Reply to the customer in plain text instead.";

/**
 * Creates an eve tool that sends Apple Messages for Business interactive
 * messages (quick reply, list picker, time picker, form) into the current
 * Blooio conversation. The input schema is Blooio's published schema for
 * model-generated interactive objects.
 *
 * The target chat comes from the session's `chat_id` auth attribute (set by
 * the default Blooio auth), falling back to the latest `<blooio_context>`
 * block. A successful send ends the turn (eve 0.69+).
 *
 * @example
 * ```ts
 * // agent/tools/blooio_interactive.ts
 * import { blooioInteractiveTool } from "eve-channel-blooio/tools";
 *
 * export default blooioInteractiveTool();
 * ```
 */
export function blooioInteractiveTool(config: BlooioInteractiveToolConfig = {}) {
  return defineTool({
    description: config.description ?? DEFAULT_DESCRIPTION,
    inputSchema: AMB_INTERACTIVE_TOOL_INPUT_SCHEMA,
    endsTurn: (output: BlooioInteractiveToolResult) => output.sent,
    async execute(input, ctx): Promise<BlooioInteractiveToolResult> {
      const target = resolveBlooioTarget(ctx.session.auth.current?.attributes, ctx.messages);
      if (!target) {
        return notSent("no_blooio_chat", "There is no active Blooio conversation. " + PLAIN_TEXT_INSTRUCTIONS);
      }
      if (target.channelType && target.channelType !== "amb") {
        return notSent(
          "not_apple_messages_for_business",
          `Interactive messages require Apple Messages for Business; this conversation is ${target.channelType}. ${PLAIN_TEXT_INSTRUCTIONS}`,
        );
      }

      const res = await sendBlooioMessage({
        baseUrl: config.baseUrl,
        chatId: target.chatId,
        credentials: config.credentials,
        fetch: config.fetch,
        interactive: input.interactive as BlooioInteractive,
      });
      if (res.ok) {
        return { chatId: target.chatId, messageId: readMessageId(res.body), sent: true };
      }

      const code = readErrorCode(res.body);
      if (code === "amb_capability_unavailable") {
        return notSent(code, `The customer's device can't show this interactive message. ${PLAIN_TEXT_INSTRUCTIONS}`);
      }
      if (code === "chat_closed") {
        return notSent(code, "The customer closed this conversation. Do not send anything else.");
      }
      if (res.status === 400 || res.status === 422) {
        return notSent(
          code ?? "invalid_interactive",
          `Blooio rejected the interactive message: ${readErrorMessage(res.body) ?? "invalid request"}. Fix the fields and try again, or reply in plain text.`,
        );
      }
      throw new Error(`blooioInteractiveTool: send failed with status ${res.status}${code ? ` (${code})` : ""}.`);
    },
  });
}

interface BlooioTarget {
  readonly chatId: string;
  readonly channelType: string | undefined;
}

function resolveBlooioTarget(
  attributes: Readonly<Record<string, string | readonly string[]>> | undefined,
  messages: readonly ModelMessage[] | undefined,
): BlooioTarget | null {
  const chatId = attributes?.chat_id;
  if (typeof chatId === "string" && chatId.length > 0) {
    const channelType = attributes?.channel_type;
    return { chatId, channelType: typeof channelType === "string" ? channelType : undefined };
  }
  return targetFromContextBlocks(messages ?? []);
}

function targetFromContextBlocks(messages: readonly ModelMessage[]): BlooioTarget | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== "user") continue;
    for (const text of messageTexts(message)) {
      const block = /<blooio_context>([\s\S]*?)<\/blooio_context>/.exec(text)?.[1];
      const chatId = block && /^chat_id: (\S+)$/m.exec(block)?.[1];
      if (chatId) return { chatId, channelType: /^channel_type: (\S+)$/m.exec(block)?.[1] };
    }
  }
  return null;
}

function messageTexts(message: ModelMessage): string[] {
  if (typeof message.content === "string") return [message.content];
  if (!Array.isArray(message.content)) return [];
  return message.content.flatMap((part) =>
    typeof part === "object" && part !== null && part.type === "text" ? [part.text] : [],
  );
}

function notSent(reason: string, instructions: string): BlooioInteractiveToolResult {
  return { instructions, reason, sent: false };
}

function readMessageId(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const id = (body as Record<string, unknown>).id;
  return typeof id === "string" ? id : undefined;
}

function readError(body: unknown): Record<string, unknown> | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const error = (body as Record<string, unknown>).error;
  return typeof error === "object" && error !== null ? (error as Record<string, unknown>) : undefined;
}

function readErrorCode(body: unknown): string | undefined {
  const code = readError(body)?.code;
  return typeof code === "string" ? code : undefined;
}

function readErrorMessage(body: unknown): string | undefined {
  const message = readError(body)?.message;
  return typeof message === "string" ? message : undefined;
}
