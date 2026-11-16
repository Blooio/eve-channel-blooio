import type { SessionAuthContext } from "eve/context";

import type { BlooioInboundMessage } from "./inbound.js";
import type {
  BlooioChannelEvents,
  BlooioContext,
  BlooioInboundResult,
} from "./blooioChannel.js";

/** Default identity projection for an inbound Blooio sender. */
export function defaultBlooioAuth(message: BlooioInboundMessage): SessionAuthContext {
  const attributes: Record<string, string> = {
    channel: message.isGroup ? "group" : "direct",
    chat_id: message.chatId,
  };
  if (message.sender) attributes.from = message.sender;
  if (message.recipient) attributes.to = message.recipient;
  if (message.channelType) attributes.channel_type = message.channelType;
  if (message.isGroup && message.groupId) attributes.group_id = message.groupId;
  if (message.protocol) attributes.protocol = message.protocol;

  const principal = message.isGroup && message.groupId ? message.groupId : (message.sender ?? message.chatId);

  return {
    attributes,
    authenticator: "blooio-webhook",
    issuer: "blooio",
    principalId: `blooio:${principal}`,
    principalType: "user",
  };
}

/** Default inbound message hook: dispatch with Blooio sender auth. */
export function defaultOnMessage(
  _ctx: BlooioContext,
  message: BlooioInboundMessage,
): BlooioInboundResult {
  return { auth: defaultBlooioAuth(message) };
}

/**
 * Built-in Blooio event handlers for text delivery and terminal errors. On
 * Apple Messages for Business, a typing indicator is shown while the agent
 * works, as Apple's Experience Review expects before bot replies.
 */
export const defaultEvents: BlooioChannelEvents = {
  async "turn.started"(_event, { channel }) {
    if (!channel.blooio.isAppleMessagesForBusiness || !channel.blooio.chatId) return;
    await channel.blooio.startTyping().catch(() => undefined);
  },

  async "content.completed"({ data }, { channel }) {
    if (data.kind !== "text" || data.phase !== "reply" || typeof data.value !== "string" || !data.value) return;
    await channel.blooio.sendMessage(data.value);
  },

  async "turn.settled"({ data }, { channel }) {
    if (data.outcome !== "failed") return;
    const message = data.error?.message;
    await channel.blooio.sendMessage(
      [
        `I hit an error while handling your request${message ? `: ${message}` : ""}.`,
        "",
        "Please try again, rephrase, or reach out if it keeps failing.",
      ].join("\n"),
    );
  },

  async "session.ended"({ data }, { channel }) {
    if (data.outcome !== "failed") return;
    const message = data.error?.message;
    await channel.blooio.sendMessage(
      [
        `This session could not recover from an error${message ? `: ${message}` : ""}.`,
        "",
        "Send a new message to continue.",
      ].join("\n"),
    );
  },
};
