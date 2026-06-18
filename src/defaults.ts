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
    from: message.sender,
  };
  if (message.internalId) attributes.to = message.internalId;
  if (message.isGroup && message.groupId) attributes.group_id = message.groupId;
  if (message.protocol) attributes.protocol = message.protocol;

  return {
    attributes,
    authenticator: "blooio-webhook",
    issuer: "blooio",
    principalId: `blooio:${message.isGroup && message.groupId ? message.groupId : message.sender}`,
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

/** Built-in Blooio event handlers for text delivery and terminal errors. */
export const defaultEvents: BlooioChannelEvents = {
  async "message.completed"(event, channel) {
    if (event.finishReason === "tool-calls" || !event.message) return;
    await channel.blooio.sendMessage(event.message);
  },

  async "turn.failed"(event, channel) {
    await channel.blooio.sendMessage(
      [
        `I hit an error while handling your request${event.message ? `: ${event.message}` : ""}.`,
        "",
        "Please try again, rephrase, or reach out if it keeps failing.",
      ].join("\n"),
    );
  },

  async "session.failed"(event, channel) {
    await channel.blooio.sendMessage(
      [
        `This session could not recover from an error${event.message ? `: ${event.message}` : ""}.`,
        "",
        "Send a new message to continue.",
      ].join("\n"),
    );
  },
};
