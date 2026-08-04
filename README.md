# eve-channel-blooio

A [Blooio](https://blooio.com) channel for [Vercel eve](https://vercel.com/eve). Send and receive **iMessage, RCS, and SMS** from your eve agent through the [Blooio v4 API](https://api.blooio.com/v4/openapi.json) — with native tapback reactions, typing indicators, read receipts, group chats, polls, capability checks, and history.

eve does not use the Chat SDK runtime, so this is a native eve channel built on `defineChannel`, not a Chat SDK adapter. Drop one file in `agent/channels/` and your agent answers texts.

## Install

```bash
npm install eve-channel-blooio
```

`eve` (and its `ai` peer) are peer dependencies, so install them too if you haven't:

```bash
npm install eve@latest ai
```

## Quick start

Create `agent/channels/blooio.ts`. The channel name is derived from the filename, so no `name` field is needed:

```ts
// agent/channels/blooio.ts
import { blooioChannel } from "eve-channel-blooio";

export default blooioChannel();
```

By default the channel reads credentials from environment variables:

| Variable                | Required | Description                                                             |
| ----------------------- | -------- | ----------------------------------------------------------------------- |
| `BLOOIO_API_KEY`        | Yes      | Blooio API key (`bl_live_...`, sent as a Bearer token)                  |
| `BLOOIO_WEBHOOK_SECRET` | Yes      | Webhook signing secret (`whsec_...`) for inbound signature verification |
| `BLOOIO_BASE_URL`       | No       | Override the API base URL (default `https://api.blooio.com/v4`)         |

Or pass them explicitly:

```ts
export default blooioChannel({
  credentials: {
    apiKey: () => process.env.BLOOIO_API_KEY!,
    webhookSecret: () => process.env.BLOOIO_WEBHOOK_SECRET!,
  },
});
```

## Configure the webhook

Point your Blooio webhook at the route eve serves: **`POST /eve/v1/blooio`**. Create it with the dashboard or the API:

```bash
curl -X POST https://api.blooio.com/v4/webhooks \
  -H "Authorization: Bearer $BLOOIO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://your-app.vercel.app/eve/v1/blooio", "event_types": ["*"] }'
```

Blooio signs every delivery with `X-Blooio-Signature: t=<unix>,v1=<hmac_sha256>` over `<t>.<rawBody>`. The channel verifies it in constant time and rejects timestamps older than 5 minutes (configurable via `timestampToleranceSec`).

## How it works

- **Inbound** — A verified `message.received` webhook (the v4 envelope `{ id, type, created_at, organization_id, data }`) is parsed and dispatched into the agent. Conversations are sticky to their Blooio chat via a continuation token (`blooio:<chatId>`). Delivery-status and other events (`message.delivered`, `typing.*`, `poll.*`, …) are acknowledged and ignored.
- **Inbound attachments** — Images, video, audio, and documents on an inbound message are forwarded to the model as multimodal `UserContent` file parts (one per attachment, alongside any text). Blooio re-hosts inbound media at servable URLs, so they pass straight through to your model provider — no extra download step or `fetchFile` hook required.
- **Outbound** — When the agent produces a reply, the default `message.completed` handler sends it back through `POST /chats/{chatId}/messages`. Errors are reported to the conversation.

## Capabilities

The `BlooioHandle` exposed to hooks and event handlers wraps the Blooio v4 messaging surface:

```ts
export default blooioChannel({
  events: {
    async "message.completed"(event, channel) {
      if (!event.message) return;
      // tapback the user's message, then reply
      await channel.blooio.react("msg_123", "+love");
      await channel.blooio.startTyping();
      await channel.blooio.sendMessage(event.message);
      await channel.blooio.markRead();
    },
  },
});
```

`channel.blooio` supports:

- `sendMessage(text, options?)` — text and/or public media URLs; replies to the bound chat, or routes to the recipient for a proactive conversation
- `react(messageId, reaction, options?)` — add (`+`) or remove (`-`) tapbacks (`love`, `like`, `dislike`, `laugh`, `emphasize`, `question`) or any emoji
- `startTyping()` / `stopTyping()` — animated typing indicator (iMessage-only)
- `markRead()` — send a read receipt
- `sendPoll(title, options)` — send a native Blooio poll
- `shareContactCard()` — share the sending number's contact card
- `lookupNumber(number?)` — check a phone number's reachability and capabilities (defaults to the sender)
- `contactCapabilities(contactId)` — per-identity capabilities for a saved contact (`ct_...`)
- `listMessages(options?)` — conversation history (cursor-paginated)
- `request(method, path, body?, query?)` — raw escape hatch to any Blooio v4 endpoint

## Configuration

| Option                  | Default          | Description                                                   |
| ----------------------- | ---------------- | ------------------------------------------------------------- |
| `credentials`           | env vars         | `apiKey` and `webhookSecret` (string or async provider)      |
| `route`                 | `/eve/v1/blooio` | Inbound webhook route                                        |
| `baseUrl`               | Blooio v4 API    | API base URL override                                        |
| `allowFrom`             | `"*"`            | Exact senders allowed inbound, or `"*"` for all             |
| `fromNumber`            | auto-routing     | Default sender for proactive sends (phone, alias, or `ch_`)  |
| `channelType`           | `blooio`         | Default channel type for routed sends when no `from` is given |
| `markReadOnReceive`     | `false`          | Send a read receipt as soon as a message arrives            |
| `timestampToleranceSec` | `300`            | Max webhook signature age                                   |
| `onMessage`             | sender auth      | Inbound hook; return `{ auth }` to dispatch or `null` to drop |
| `events`                | text delivery    | Override session lifecycle handlers                         |

## Proactive messages

Start a conversation from another channel or a schedule via `receive`. Address a recipient with `to` (a chat is created on first send):

```ts
await receive(blooio, {
  message: "Your order shipped!",
  target: { to: "+15551234567", from: "+15557654321" },
  auth: null,
});
```

## Thread / continuation tokens

Inbound conversations are keyed as `blooio:<chatId>` so a thread stays bound to its Blooio chat. Use `blooioContinuationToken(chatId)` to build the channel-local token.

## License

MIT © Blooio
