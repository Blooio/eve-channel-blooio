import type { UserContent } from "ai";
import {
  defineChannel,
  POST,
  type Channel,
  type ChannelContinuationOps,
  type ChannelEvents,
  type ChannelFrom,
} from "eve/channels";
import type { SessionAuthContext } from "eve/context";

import {
  blooioContinuationToken,
  callBlooioApi,
  getBlooioContactCapabilities,
  listBlooioMessages,
  lookupBlooioNumber,
  markBlooioChatRead,
  reactBlooioMessage,
  sendBlooioMessage,
  sendBlooioPoll,
  sendBlooioToRecipient,
  shareBlooioContactCard,
  startBlooioTyping,
  stopBlooioTyping,
  type BlooioApiResponse,
  type BlooioChannelType,
  type BlooioCredentials,
  type BlooioFetch,
  type BlooioListMessagesInput,
} from "./api.js";
import { defaultEvents, defaultOnMessage } from "./defaults.js";
import {
  formatBlooioContextBlock,
  parseBlooioInboundMessage,
  resolveAttachmentMediaType,
  type BlooioInboundMessage,
} from "./inbound.js";
import { verifyBlooioRequest, type BlooioWebhookSecret } from "./verify.js";

/** Pre-dispatch Blooio context passed to the inbound message hook. */
export interface BlooioContext {
  readonly blooio: BlooioHandle;
}

/** Channel-owned Blooio context returned by `context()`. */
export interface BlooioChannelContext extends BlooioContext {
  state: BlooioChannelState;
}

/** Event-handler Blooio context, including continuation routing. */
export type BlooioEventContext = BlooioChannelContext & ChannelContinuationOps;

/** JSON-serializable durable state for one Blooio v4 conversation. */
export interface BlooioChannelState {
  /** Chat id (`chat_...`). The reply target for an active conversation. */
  chatId: string | null;
  /** Recipient handle for a proactive conversation before a chat exists. */
  to: string | null;
  /** Sender (`from`) for a proactive conversation: phone, alias, or `ch_...`. */
  from: string | null;
  /** Channel type of the conversation, e.g. `blooio`. */
  channelType: string | null;
  /** Sender of the most recent inbound message. */
  sender: string | null;
  /** Whether the conversation is a group chat. */
  isGroup: boolean;
  /** Group id (`grp_...`) when the conversation is a group. */
  groupId: string | null;
  /** Most recent inbound Blooio message id. */
  lastMessageId: string | null;
}

/** Per-session instrumentation snapshot for Blooio runtime telemetry. */
export interface BlooioInstrumentationMetadata extends Record<string, unknown> {
  readonly chatId: string | null;
  readonly channelType: string | null;
  readonly isGroup: boolean;
  readonly groupId: string | null;
  readonly lastMessageId: string | null;
}

/** Sender allow list for inbound Blooio webhook triggers. `"*"` allows everyone. */
export type BlooioAllowFrom =
  | string
  | readonly string[]
  | (() => string | readonly string[] | Promise<string | readonly string[]>);

/** Result of an inbound Blooio message hook. Return `null` to drop the webhook without dispatching. */
export type BlooioInboundResult = {
  auth: SessionAuthContext | null;
} | null;

/** Sync or async {@link BlooioInboundResult}. */
export type BlooioInboundResultOrPromise = BlooioInboundResult | Promise<BlooioInboundResult>;

/** Target accepted by `receive(blooio, { target })` for proactive conversations. */
export interface BlooioReceiveTarget {
  /** Recipient: phone (any common format), email, or opaque provider id. */
  readonly to: string;
  /** Exact sender (phone, alias, or `ch_...`). Mutually exclusive with `channelType`. */
  readonly from?: string;
  /** Constrain routing to a channel type. Defaults to `blooio` when `from` is omitted. */
  readonly channelType?: BlooioChannelType;
}

type BlooioEventHandlerMap = ChannelEvents<BlooioChannelContext>;

/** Event handlers supported by `blooioChannel({ events })`. */
export type BlooioChannelEvents = BlooioEventHandlerMap;

/** Per-call overrides for {@link BlooioHandle.sendMessage}. */
export interface BlooioSendMessageOptions {
  /** Chat id override. Defaults to the conversation's `chatId`. */
  readonly chatId?: string;
  /** Recipient override (routed send). Defaults to the conversation's `to`. */
  readonly to?: string;
  /** Sender override (routed send): phone, alias, or `ch_...`. */
  readonly from?: string;
  /** Channel type for a routed send. Defaults to the config value, then `blooio`. */
  readonly channelType?: BlooioChannelType;
  /** Public https media URLs. */
  readonly attachments?: readonly string[];
  /** Idempotency key to de-duplicate sends. */
  readonly idempotencyKey?: string;
}

/** Low-level Blooio handle exposed to hooks and event handlers. */
export interface BlooioHandle {
  /** Chat id bound to this conversation, when known. */
  readonly chatId: string | undefined;
  /** Recipient bound to this conversation, when known. */
  readonly to: string | undefined;
  /** Sender of the most recent inbound message, when known. */
  readonly sender: string | undefined;
  readonly isGroup: boolean;
  /**
   * Sends a text and/or attachment message to this conversation. Replies to the
   * bound chat (`chat_...`) when one exists, otherwise routes to the recipient.
   */
  sendMessage(message: string, options?: BlooioSendMessageOptions): Promise<BlooioApiResponse>;
  /** Adds (`+`) or removes (`-`) a tapback/emoji reaction on a message. */
  react(
    messageId: string,
    reaction: string,
    options?: { chatId?: string },
  ): Promise<BlooioApiResponse>;
  /** Shows the typing indicator (iMessage-only). */
  startTyping(chatId?: string): Promise<BlooioApiResponse>;
  /** Hides the typing indicator. */
  stopTyping(chatId?: string): Promise<BlooioApiResponse>;
  /** Marks the conversation read and sends a read receipt. */
  markRead(chatId?: string): Promise<BlooioApiResponse>;
  /** Sends a native poll to the conversation. */
  sendPoll(title: string, options: readonly string[], chatId?: string): Promise<BlooioApiResponse>;
  /** Shares the sending number's contact card into the conversation. */
  shareContactCard(chatId?: string): Promise<BlooioApiResponse>;
  /** Looks up a phone number's reachability and capabilities. Defaults to the sender. */
  lookupNumber(number?: string): Promise<BlooioApiResponse>;
  /** Gets a contact's per-identity capabilities (`ct_...`). */
  contactCapabilities(contactId: string): Promise<BlooioApiResponse>;
  /** Lists messages in the conversation (cursor-paginated). */
  listMessages(
    options?: Omit<BlooioListMessagesInput, "chatId" | "credentials" | "baseUrl" | "fetch"> & {
      chatId?: string;
    },
  ): Promise<BlooioApiResponse>;
  /** Raw Blooio v4 API escape hatch. `path` is appended to the API base URL. */
  request(
    method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT",
    path: string,
    body?: unknown,
    query?: Readonly<Record<string, string | number | boolean | undefined | null>>,
  ): Promise<BlooioApiResponse>;
}

/** Configuration for {@link blooioChannel}. */
export interface BlooioChannelConfig {
  readonly credentials?: BlooioCredentials;
  /** Route for the Blooio webhook. Defaults to `/eve/v1/blooio`. */
  readonly route?: string;
  /** Override the API base URL. Falls back to `BLOOIO_BASE_URL`, then the public default. */
  readonly baseUrl?: string;
  /** Fetch override for REST calls. */
  readonly fetch?: BlooioFetch;
  /** Maximum allowed age of a webhook signature, in seconds. Defaults to 300. */
  readonly timestampToleranceSec?: number;
  /**
   * Exact senders allowed to reach the inbound hook, or `"*"` to allow every
   * verified sender. Defaults to `"*"`.
   */
  readonly allowFrom?: BlooioAllowFrom;
  /** Default sender for routed (proactive) sends: phone, alias, or `ch_...`. */
  readonly fromNumber?: string;
  /** Default channel type for routed sends when no `from` is given. Defaults to `blooio`. */
  readonly channelType?: BlooioChannelType;
  /** Mark conversations read when an inbound message is received. Defaults to `false`. */
  readonly markReadOnReceive?: boolean;

  /** Inbound message hook. Defaults to sender auth and dispatch. */
  onMessage?(ctx: BlooioContext, message: BlooioInboundMessage): BlooioInboundResultOrPromise;

  readonly events?: BlooioChannelEvents;

  /** Optional override for the secret used to verify webhook signatures. */
  readonly webhookSecret?: BlooioWebhookSecret;
}

/** Concrete return type of {@link blooioChannel}. */
export interface BlooioChannel
  extends Channel<BlooioChannelState, BlooioReceiveTarget, BlooioInstrumentationMetadata> {}

const EMPTY_STATE: BlooioChannelState = {
  channelType: null,
  chatId: null,
  from: null,
  groupId: null,
  isGroup: false,
  lastMessageId: null,
  sender: null,
  to: null,
};

/**
 * Blooio channel factory for inbound and outbound iMessage, RCS, and SMS via
 * the Blooio v4 API. Verifies `X-Blooio-Signature` webhooks, dispatches
 * `message.received` events into the agent, and replies through the Blooio
 * REST API.
 */
export function blooioChannel(config: BlooioChannelConfig = {}): BlooioChannel {
  const route = config.route ?? "/eve/v1/blooio";
  const allowFrom = config.allowFrom ?? "*";
  const onMessage = config.onMessage ?? defaultOnMessage;
  const mergedEvents: BlooioChannelEvents = { ...defaultEvents, ...config.events };

  return defineChannel<
    BlooioChannelState,
    BlooioChannelContext,
    BlooioReceiveTarget,
    BlooioInstrumentationMetadata
  >({
    kindHint: "blooio",
    state: EMPTY_STATE,
    metadata(state): BlooioInstrumentationMetadata {
      return {
        channelType: state.channelType,
        chatId: state.chatId,
        groupId: state.groupId,
        isGroup: state.isGroup,
        lastMessageId: state.lastMessageId,
      };
    },

    context(state): BlooioChannelContext {
      return {
        state,
        blooio: buildBlooioHandle({ config, state }),
      };
    },

    routes: [
      POST<BlooioChannelState>(route, async (req, { from, waitUntil }) => {
        const verified = await verifyInbound(req, config);
        if (verified === null) return new Response("unauthorized", { status: 401 });

        const message = parsePayload(verified.body);
        // Acknowledge non-inbound events (delivery status, polls, typing, etc.).
        if (!message) return new Response("ok");
        if (!(await isAllowed(message.sender, allowFrom))) {
          return new Response("forbidden", { status: 403 });
        }

        waitUntil(dispatch({ config, from, message, onMessage }));
        return new Response("ok");
      }),
    ],

    async receive(input, { from }) {
      const to = input.target.to;
      if (!to) throw new Error("blooioChannel().receive requires target.to.");
      const fromAddress = input.target.from ?? config.fromNumber ?? null;
      const channelType = input.target.channelType ?? config.channelType ?? null;
      return from(blooioContinuationToken(to)).send(input.message, {
        auth: input.auth,
        state: {
          ...EMPTY_STATE,
          channelType,
          from: fromAddress,
          to,
        },
      });
    },

    events: mergedEvents,
  });
}

async function verifyInbound(
  req: Request,
  config: BlooioChannelConfig,
): Promise<{ body: string } | null> {
  try {
    return await verifyBlooioRequest(req, {
      timestampToleranceSec: config.timestampToleranceSec,
      webhookSecret: config.webhookSecret ?? config.credentials?.webhookSecret,
    });
  } catch {
    return null;
  }
}

function parsePayload(body: string): BlooioInboundMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  return parseBlooioInboundMessage(parsed);
}

function stateFromInbound(message: BlooioInboundMessage): BlooioChannelState {
  return {
    channelType: message.channelType ?? null,
    chatId: message.chatId,
    from: message.recipient ?? null,
    groupId: message.groupId ?? null,
    isGroup: message.isGroup,
    lastMessageId: message.messageId ?? null,
    sender: message.sender ?? null,
    to: message.sender ?? null,
  };
}

async function dispatch(input: {
  readonly config: BlooioChannelConfig;
  readonly from: ChannelFrom<BlooioChannelState>;
  readonly message: BlooioInboundMessage;
  readonly onMessage: NonNullable<BlooioChannelConfig["onMessage"]>;
}): Promise<void> {
  const { config, from, message } = input;
  const state = stateFromInbound(message);
  const handle = buildBlooioHandle({ config, state });

  if (config.markReadOnReceive) {
    await handle.markRead().catch(() => undefined);
  }

  let result: BlooioInboundResult;
  try {
    result = await input.onMessage({ blooio: handle }, message);
  } catch {
    return;
  }
  if (!result) return;

  await from(blooioContinuationToken(message.chatId))
    .send(buildInboundMessageContent(message), {
      auth: result.auth,
      context: [formatBlooioContextBlock(message)],
      state,
    })
    .catch(() => undefined);
}

/**
 * Builds the delivery content for an inbound message. When the message
 * carries attachments, returns a multimodal `UserContent` array (text part
 * plus one file part per attachment) so the model can see the media. Blooio
 * re-hosts inbound media at servable URLs, so the file-part URLs pass straight
 * through to the model provider. Text-only messages return a plain string.
 */
function buildInboundMessageContent(message: BlooioInboundMessage): string | UserContent {
  const files = message.attachments.filter(
    (attachment): attachment is typeof attachment & { url: string } =>
      typeof attachment.url === "string" && attachment.url.length > 0,
  );
  if (files.length === 0) return message.text;

  const parts: Exclude<UserContent, string> = [];
  if (message.text) parts.push({ type: "text", text: message.text });
  for (const attachment of files) {
    parts.push({
      type: "file",
      data: new URL(attachment.url),
      mediaType: resolveAttachmentMediaType(attachment),
    });
  }
  return parts;
}

function buildBlooioHandle(input: {
  readonly config: BlooioChannelConfig;
  readonly state: BlooioChannelState;
}): BlooioHandle {
  const { config, state } = input;
  const shared = {
    baseUrl: config.baseUrl,
    credentials: config.credentials,
    fetch: config.fetch,
  };
  const boundChatId = state.chatId ?? undefined;
  const defaultFrom = state.from ?? config.fromNumber ?? undefined;
  const defaultChannelType = (state.channelType as BlooioChannelType | null) ?? config.channelType;

  function requireChatId(override?: string): string {
    const chatId = override ?? boundChatId;
    if (!chatId) throw new Error("blooioChannel: this action requires an active chat.");
    return chatId;
  }

  return {
    chatId: boundChatId,
    isGroup: state.isGroup,
    sender: state.sender ?? undefined,
    to: state.to ?? undefined,
    sendMessage(message, options) {
      const chatId = options?.chatId ?? boundChatId;
      if (chatId) {
        return sendBlooioMessage({
          ...shared,
          attachments: options?.attachments,
          chatId,
          idempotencyKey: options?.idempotencyKey,
          text: message,
        });
      }
      const to = options?.to ?? state.to ?? undefined;
      if (!to) throw new Error("blooioChannel: sendMessage requires an active chat or a recipient.");
      return sendBlooioToRecipient({
        ...shared,
        attachments: options?.attachments,
        channelType: options?.channelType ?? defaultChannelType,
        from: options?.from ?? defaultFrom,
        idempotencyKey: options?.idempotencyKey,
        text: message,
        to,
      });
    },
    react(messageId, reaction, options) {
      return reactBlooioMessage({
        ...shared,
        chatId: requireChatId(options?.chatId),
        messageId,
        reaction,
      });
    },
    startTyping(chatId) {
      return startBlooioTyping({ ...shared, chatId: requireChatId(chatId) });
    },
    stopTyping(chatId) {
      return stopBlooioTyping({ ...shared, chatId: requireChatId(chatId) });
    },
    markRead(chatId) {
      return markBlooioChatRead({ ...shared, chatId: requireChatId(chatId) });
    },
    sendPoll(title, options, chatId) {
      return sendBlooioPoll({ ...shared, chatId: requireChatId(chatId), options, title });
    },
    shareContactCard(chatId) {
      return shareBlooioContactCard({ ...shared, chatId: requireChatId(chatId) });
    },
    lookupNumber(number) {
      const target = number ?? state.sender ?? undefined;
      if (!target) throw new Error("blooioChannel: lookupNumber requires a number.");
      return lookupBlooioNumber({ ...shared, number: target });
    },
    contactCapabilities(contactId) {
      return getBlooioContactCapabilities({ ...shared, contactId });
    },
    listMessages(options) {
      return listBlooioMessages({
        ...shared,
        ...options,
        chatId: requireChatId(options?.chatId),
      });
    },
    request(method, path, body, query) {
      return callBlooioApi({ ...shared, body, method, path, query });
    },
  };
}

async function isAllowed(
  sender: string | undefined,
  allowFrom: BlooioAllowFrom,
): Promise<boolean> {
  const resolved = typeof allowFrom === "function" ? await allowFrom() : allowFrom;
  if (resolved === "*") return true;
  if (!sender) return false;
  return typeof resolved === "string" ? resolved === sender : resolved.includes(sender);
}
