/**
 * Minimal Blooio v4 REST API client used by the Blooio channel.
 *
 * Requests use JSON bodies and Bearer authentication
 * (`Authorization: Bearer bl_live_...`). No Blooio SDK dependency is
 * required or exposed through the channel's public API.
 * See https://api.blooio.com/v4/openapi.json.
 */

/** Default base URL for the Blooio v4 API. */
export const DEFAULT_BLOOIO_BASE_URL = "https://api.blooio.com/v4";

/** API key, materialized directly or from an async secret provider. */
export type BlooioApiKey = string | (() => string | Promise<string>);

/** Fetch implementation override matching the global `fetch` signature. Defaults to the runtime global; supply a custom one for tests or non-standard runtimes. */
export type BlooioFetch = typeof fetch;

/** Blooio v4 channel type. `blooio` is the iMessage / RCS / SMS channel. */
export type BlooioChannelType =
  | "blooio"
  | "twilio"
  | "whatsapp"
  | "whatsapp_business"
  | "rcs_business";

/** Credentials required for Blooio REST API calls and webhook verification. */
export interface BlooioCredentials {
  /** Blooio API key (`bl_live_...`, sent as a Bearer token). Falls back to `BLOOIO_API_KEY`. */
  readonly apiKey?: BlooioApiKey;
  /** Webhook signing secret (`whsec_...`). Falls back to `BLOOIO_WEBHOOK_SECRET`. */
  readonly webhookSecret?: string | (() => string | Promise<string>);
}

/** Shared Blooio REST API options. */
export interface BlooioApiOptions {
  readonly credentials?: BlooioCredentials;
  /** Override the API base URL. Falls back to `BLOOIO_BASE_URL`, then the public default. */
  readonly baseUrl?: string;
  readonly fetch?: BlooioFetch;
}

/**
 * Result of a Blooio REST call: HTTP `status`, an `ok` flag, and `body`.
 * `body` holds parsed JSON for a JSON response, the raw text string
 * otherwise, or `null` when empty.
 */
export interface BlooioApiResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly body: unknown;
}

/** Parameters for sending a message to an existing chat (`POST /chats/{chatId}/messages`). */
export interface BlooioSendMessageInput extends BlooioApiOptions {
  /** Chat id (`chat_...`). */
  readonly chatId: string;
  readonly text?: string;
  /** Public https media URLs. May be combined with `text` (sent as media with a caption). */
  readonly attachments?: readonly string[];
  /** Unique key to prevent duplicate sends. Re-using a key returns the original result. */
  readonly idempotencyKey?: string;
}

/** Parameters for a routed send to a recipient (`POST /messages`). Used for proactive conversations. */
export interface BlooioSendToRecipientInput extends BlooioApiOptions {
  /** Recipient: phone (any common format), email, or opaque provider id. */
  readonly to: string;
  readonly text?: string;
  readonly attachments?: readonly string[];
  /** Exact sender (phone, channel alias, or `ch_...`). Mutually exclusive with `channelType`. */
  readonly from?: string;
  /** Constrain automatic routing to one channel type. Defaults to `blooio` when `from` is omitted. */
  readonly channelType?: BlooioChannelType;
  readonly idempotencyKey?: string;
}

/** Parameters for adding or removing a reaction on a message (`POST /chats/{chatId}/messages/{messageId}/reactions`). */
export interface BlooioReactInput extends BlooioApiOptions {
  readonly chatId: string;
  /** Message id (`msg_...`). */
  readonly messageId: string;
  /** Prefix with `+` to add or `-` to remove. Tapbacks: love, like, dislike, laugh, emphasize, question. Emoji also accepted. */
  readonly reaction: string;
}

/** Parameters for listing messages in a chat (`GET /chats/{chatId}/messages`). Cursor-paginated. */
export interface BlooioListMessagesInput extends BlooioApiOptions {
  readonly chatId: string;
  readonly limit?: number;
  /** Opaque pagination cursor from a prior response's `next_cursor`. */
  readonly cursor?: string;
  readonly order?: "asc" | "desc";
}

/** Parameters for sending a native poll (`POST /chats/{chatId}/polls`). */
export interface BlooioSendPollInput extends BlooioApiOptions {
  readonly chatId: string;
  readonly title: string;
  readonly options: readonly string[];
}

/**
 * Builds the Blooio channel-local continuation token from a chat id
 * (`chat_...`). The route `send()` namespaces this with the channel name
 * before handing it to the runtime (`blooio:<chatId>`), keeping a
 * conversation sticky to its Blooio chat.
 */
export function blooioContinuationToken(chatId: string): string {
  return chatId;
}

/** Resolves a Blooio API key, falling back to `BLOOIO_API_KEY`. */
export async function resolveBlooioApiKey(apiKey?: BlooioApiKey): Promise<string> {
  const source = apiKey ?? process.env.BLOOIO_API_KEY;
  if (!source) throw new Error("blooioChannel: BLOOIO_API_KEY is required.");
  return typeof source === "function" ? await source() : source;
}

/** Resolves the API base URL, falling back to `BLOOIO_BASE_URL` then the public default. */
export function resolveBlooioBaseUrl(baseUrl?: string): string {
  const resolved = baseUrl ?? process.env.BLOOIO_BASE_URL ?? DEFAULT_BLOOIO_BASE_URL;
  return resolved.endsWith("/") ? resolved.slice(0, -1) : resolved;
}

/**
 * Calls the Blooio v4 REST API with Bearer auth and an optional JSON body.
 *
 * `path` is relative to the resolved base URL and must begin with `/`.
 */
export async function callBlooioApi(
  input: BlooioApiOptions & {
    readonly method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
    readonly path: string;
    readonly body?: unknown;
    readonly query?: Readonly<Record<string, string | number | boolean | undefined | null>>;
    readonly headers?: Readonly<Record<string, string>>;
  },
): Promise<BlooioApiResponse> {
  const apiKey = await resolveBlooioApiKey(input.credentials?.apiKey);
  const apiFetch = input.fetch ?? fetch;
  const base = resolveBlooioBaseUrl(input.baseUrl);
  const url = new URL(`${base}${input.path}`);
  if (input.query) {
    for (const [key, value] of Object.entries(input.query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }

  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
    ...input.headers,
  };
  let body: string | undefined;
  if (input.body !== undefined && input.method !== "GET") {
    headers["content-type"] = "application/json";
    body = JSON.stringify(input.body);
  }

  const response = await apiFetch(url.toString(), {
    method: input.method,
    headers,
    body,
  });
  return {
    status: response.status,
    ok: response.ok,
    body: await parseResponseBody(response),
  };
}

/** Builds the message content body shared by chat and routed sends. */
function messageContentBody(text?: string, attachments?: readonly string[]): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (text) body.text = text;
  if (attachments && attachments.length > 0) body.attachments = [...attachments];
  return body;
}

/** Sends a text and/or attachment message to an existing chat (`POST /chats/{chatId}/messages`). */
export async function sendBlooioMessage(input: BlooioSendMessageInput): Promise<BlooioApiResponse> {
  if (!input.text && (!input.attachments || input.attachments.length === 0)) {
    throw new Error("blooioChannel: sending a message requires text or at least one attachment.");
  }
  return callBlooioApi({
    baseUrl: input.baseUrl,
    credentials: input.credentials,
    fetch: input.fetch,
    method: "POST",
    path: `/chats/${encodeURIComponent(input.chatId)}/messages`,
    body: messageContentBody(input.text, input.attachments),
    headers: input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : undefined,
  });
}

/**
 * Sends a routed message to a recipient (`POST /messages`), used to start a
 * proactive conversation. Defaults routing to the Blooio channel type unless an
 * explicit `from` is supplied (the two are mutually exclusive in the v4 API).
 */
export async function sendBlooioToRecipient(
  input: BlooioSendToRecipientInput,
): Promise<BlooioApiResponse> {
  if (!input.text && (!input.attachments || input.attachments.length === 0)) {
    throw new Error("blooioChannel: sending a message requires text or at least one attachment.");
  }
  const body: Record<string, unknown> = {
    ...messageContentBody(input.text, input.attachments),
    to: input.to,
  };
  if (input.from) {
    body.from = input.from;
  } else {
    body.channel_type = input.channelType ?? "blooio";
  }

  return callBlooioApi({
    baseUrl: input.baseUrl,
    credentials: input.credentials,
    fetch: input.fetch,
    method: "POST",
    path: "/messages",
    body,
    headers: input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : undefined,
  });
}

/** Adds or removes a tapback/emoji reaction on a message. */
export async function reactBlooioMessage(input: BlooioReactInput): Promise<BlooioApiResponse> {
  return callBlooioApi({
    baseUrl: input.baseUrl,
    credentials: input.credentials,
    fetch: input.fetch,
    method: "POST",
    path: `/chats/${encodeURIComponent(input.chatId)}/messages/${encodeURIComponent(
      input.messageId,
    )}/reactions`,
    body: { reaction: input.reaction },
  });
}

/** Shows the typing indicator in a chat (`POST /chats/{chatId}/typing`). iMessage-only. */
export async function startBlooioTyping(
  input: BlooioApiOptions & { readonly chatId: string },
): Promise<BlooioApiResponse> {
  return callBlooioApi({
    baseUrl: input.baseUrl,
    credentials: input.credentials,
    fetch: input.fetch,
    method: "POST",
    path: `/chats/${encodeURIComponent(input.chatId)}/typing`,
    body: { state: "started" },
  });
}

/** Hides the typing indicator in a chat (`POST /chats/{chatId}/typing`). */
export async function stopBlooioTyping(
  input: BlooioApiOptions & { readonly chatId: string },
): Promise<BlooioApiResponse> {
  return callBlooioApi({
    baseUrl: input.baseUrl,
    credentials: input.credentials,
    fetch: input.fetch,
    method: "POST",
    path: `/chats/${encodeURIComponent(input.chatId)}/typing`,
    body: { state: "stopped" },
  });
}

/** Marks a chat as read and sends a read receipt (`POST /chats/{chatId}/read`). */
export async function markBlooioChatRead(
  input: BlooioApiOptions & { readonly chatId: string },
): Promise<BlooioApiResponse> {
  return callBlooioApi({
    baseUrl: input.baseUrl,
    credentials: input.credentials,
    fetch: input.fetch,
    method: "POST",
    path: `/chats/${encodeURIComponent(input.chatId)}/read`,
  });
}

/**
 * Looks up a phone number's reachability and capabilities
 * (`GET /phone-numbers/lookup`). Accepts any common phone format.
 */
export async function lookupBlooioNumber(
  input: BlooioApiOptions & { readonly number: string },
): Promise<BlooioApiResponse> {
  return callBlooioApi({
    baseUrl: input.baseUrl,
    credentials: input.credentials,
    fetch: input.fetch,
    method: "GET",
    path: "/phone-numbers/lookup",
    query: { number: input.number },
  });
}

/** Gets a contact's per-identity capabilities (`GET /contacts/{contactId}/capabilities`). */
export async function getBlooioContactCapabilities(
  input: BlooioApiOptions & { readonly contactId: string },
): Promise<BlooioApiResponse> {
  return callBlooioApi({
    baseUrl: input.baseUrl,
    credentials: input.credentials,
    fetch: input.fetch,
    method: "GET",
    path: `/contacts/${encodeURIComponent(input.contactId)}/capabilities`,
  });
}

/** Lists messages in a chat with cursor pagination (`GET /chats/{chatId}/messages`). */
export async function listBlooioMessages(
  input: BlooioListMessagesInput,
): Promise<BlooioApiResponse> {
  return callBlooioApi({
    baseUrl: input.baseUrl,
    credentials: input.credentials,
    fetch: input.fetch,
    method: "GET",
    path: `/chats/${encodeURIComponent(input.chatId)}/messages`,
    query: {
      cursor: input.cursor,
      limit: input.limit,
      order: input.order,
    },
  });
}

/** Sends a native poll to a chat (`POST /chats/{chatId}/polls`). */
export async function sendBlooioPoll(input: BlooioSendPollInput): Promise<BlooioApiResponse> {
  return callBlooioApi({
    baseUrl: input.baseUrl,
    credentials: input.credentials,
    fetch: input.fetch,
    method: "POST",
    path: `/chats/${encodeURIComponent(input.chatId)}/polls`,
    body: { options: [...input.options], title: input.title },
  });
}

/** Shares the sending number's contact card into a chat (`POST /chats/{chatId}/contact-card`). */
export async function shareBlooioContactCard(
  input: BlooioApiOptions & { readonly chatId: string },
): Promise<BlooioApiResponse> {
  return callBlooioApi({
    baseUrl: input.baseUrl,
    credentials: input.credentials,
    fetch: input.fetch,
    method: "POST",
    path: `/chats/${encodeURIComponent(input.chatId)}/contact-card`,
  });
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
