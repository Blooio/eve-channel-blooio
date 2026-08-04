/**
 * Blooio v4 inbound webhook parsing and prompt shaping.
 *
 * Native v4 webhooks use the envelope `{ id, type, created_at,
 * organization_id, data }`. The channel owns these small data shapes instead
 * of exposing raw Blooio payloads as its public API surface. See the Blooio
 * `message.received` event.
 */

/** One inbound attachment as delivered by a Blooio v4 webhook. */
export interface BlooioInboundAttachment {
  /** Servable, decrypted URL (Blooio re-hosts inbound media before delivery). */
  readonly url?: string;
  /** Content type (`media_type` in the webhook payload). */
  readonly mediaType?: string;
  readonly size?: number;
  readonly caption?: string;
  readonly [key: string]: unknown;
}

/** Channel-owned representation of one inbound Blooio v4 message. */
export interface BlooioInboundMessage {
  /** Event id (`evt_...`). */
  readonly eventId: string | undefined;
  /** Blooio message id (`msg_...`). */
  readonly messageId: string | undefined;
  /** Chat id (`chat_...`). The reply target and continuation-token key. */
  readonly chatId: string;
  /** Channel id (`ch_...`) that received the message. */
  readonly channelId: string | undefined;
  /** Channel type, e.g. `blooio`. */
  readonly channelType: string | undefined;
  /** Sender identifier (phone / email / opaque id). */
  readonly sender: string | undefined;
  /** The Blooio channel address that received the message (our line). */
  readonly recipient: string | undefined;
  readonly text: string;
  readonly attachments: readonly BlooioInboundAttachment[];
  /** Resolved wire transport: `imessage`, `sms`, `rcs`, `whatsapp`, `pending`, `unknown`. */
  readonly protocol: string | undefined;
  /** Content type, e.g. `text`, `media`, `interactive`, `poll`. */
  readonly messageType: string | undefined;
  readonly isGroup: boolean;
  readonly groupId: string | undefined;
  readonly groupName: string | undefined;
  /** Structured interactive reply content, when present. */
  readonly interactive: Record<string, unknown> | undefined;
  readonly receivedAt: number | undefined;
  /** The raw parsed webhook envelope. */
  readonly raw: Record<string, unknown>;
}

const BLOOIO_RESPONSE_INSTRUCTIONS =
  "Reply in plain text suitable for iMessage/SMS. Keep the response concise and avoid Markdown " +
  "formatting, tables, headings, code fences, and long lists. Ask at most one short follow-up " +
  "question when more information is needed.";

/**
 * Parses a Blooio v4 webhook envelope into a {@link BlooioInboundMessage}.
 *
 * Returns `null` for envelopes that are not inbound `message.received`
 * events, or that lack a chat id. Delivery-status events
 * (`message.sent`, `message.delivered`, etc.) are intentionally ignored.
 */
export function parseBlooioInboundMessage(payload: unknown): BlooioInboundMessage | null {
  if (!isRecord(payload)) return null;
  if (payload.type !== "message.received") return null;

  const data = isRecord(payload.data) ? payload.data : {};
  const chatId = readString(data.chat_id);
  if (!chatId) return null;

  const group = isRecord(data.group) ? data.group : undefined;
  const groupId = readString(data.group_id) ?? readString(group?.group_id);
  const isGroup = data.is_group === true || groupId !== undefined;

  return {
    attachments: readAttachments(data.attachments),
    channelId: readString(data.channel_id),
    channelType: readString(data.channel_type),
    chatId,
    eventId: readString(payload.id),
    groupId,
    groupName: readString(group?.name) ?? readString(data.group_name),
    interactive: isRecord(data.interactive) ? data.interactive : undefined,
    isGroup,
    messageId: readString(data.message_id),
    messageType: readString(data.message_type) ?? readString(data.type),
    protocol: readString(data.protocol),
    raw: payload,
    receivedAt: readNumber(payload.created_at) ?? readNumber(data.occurred_at),
    recipient: readString(data.recipient) ?? readString(data.channel_address),
    sender: readString(data.sender) ?? readString(readRecordString(data.contact, "identifier")),
    text: readString(data.text) ?? "",
  };
}

/** Renders a deterministic `<blooio_context>` block for the model. */
export function formatBlooioContextBlock(message: BlooioInboundMessage): string {
  const lines = [
    "<blooio_context>",
    `channel: ${message.isGroup ? "group" : "direct"}`,
    "response_medium: imessage",
    `response_instructions: ${BLOOIO_RESPONSE_INSTRUCTIONS}`,
    ...(message.sender ? [`from: ${message.sender}`] : []),
    ...(message.recipient ? [`to: ${message.recipient}`] : []),
    ...(message.channelType ? [`channel_type: ${message.channelType}`] : []),
    ...(message.protocol ? [`protocol: ${message.protocol}`] : []),
    ...(message.messageId ? [`message_id: ${message.messageId}`] : []),
    `chat_id: ${message.chatId}`,
    ...(message.isGroup && message.groupId ? [`group_id: ${message.groupId}`] : []),
    ...(message.isGroup && message.groupName ? [`group_name: ${message.groupName}`] : []),
    ...(message.attachments.length > 0 ? [`attachments: ${message.attachments.length}`] : []),
    "</blooio_context>",
  ];
  return lines.join("\n");
}

function readAttachments(value: unknown): BlooioInboundAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (typeof entry === "string") return { url: entry };
    if (!isRecord(entry)) return {};
    return {
      ...entry,
      url: readString(entry.url),
      mediaType: readString(entry.media_type) ?? readString(entry.mediaType),
      size: readNumber(entry.size),
      caption: readString(entry.caption),
    };
  });
}

const EXTENSION_MEDIA_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  bmp: "image/bmp",
  tiff: "image/tiff",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  avi: "video/x-msvideo",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  aac: "audio/aac",
  m4a: "audio/mp4",
  caf: "audio/x-caf",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  vcf: "text/vcard",
  json: "application/json",
  zip: "application/zip",
};

/**
 * Best-effort MIME type for an attachment: prefers the explicit `mediaType`,
 * then infers from the URL extension, then falls back to
 * `application/octet-stream`.
 */
export function resolveAttachmentMediaType(attachment: BlooioInboundAttachment): string {
  if (attachment.mediaType) return attachment.mediaType;
  const url = attachment.url;
  if (url) {
    const path = url.split(/[?#]/, 1)[0] ?? url;
    const ext = path.split(".").pop()?.toLowerCase();
    if (ext && EXTENSION_MEDIA_TYPES[ext]) return EXTENSION_MEDIA_TYPES[ext];
  }
  return "application/octet-stream";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecordString(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
