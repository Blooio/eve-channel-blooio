# eve-channel-blooio

A [Blooio](https://blooio.com) channel for [Vercel eve](https://vercel.com/eve). Send and receive **iMessage, RCS, and SMS** from your eve agent through the Blooio v2 API — with native tapback reactions, typing indicators, read receipts, group chats, and capability checks.

eve does not use the Chat SDK runtime, so this is a native eve channel built on `defineChannel`, not a Chat SDK adapter. Drop one file in `agent/channels/` and your agent answers texts.

## Install

```bash
npm install eve-channel-blooio
```

`eve` is a peer dependency, so install it too if you haven't:

```bash
npm install eve@latest
```

## Quick start

Create `agent/channels/blooio.ts`. The channel name is derived from the filename, so no `name` field is needed:

```ts
// agent/channels/blooio.ts
import { blooioChannel } from "eve-channel-blooio";

export default blooioChannel();
```

By default the channel reads credentials from environment variables:

| Variable                | Required | Description                                                              |
| ----------------------- | -------- | ------------------------------------------------------------------------ |
| `BLOOIO_API_KEY`        | Yes      | Blooio API key (Bearer token), used for outbound REST calls              |
| `BLOOIO_WEBHOOK_SECRET` | Yes      | Webhook signing secret (`whsec_...`) for inbound signature verification  |
| `BLOOIO_BASE_URL`       | No       | Override the API base URL (default `https://backend.blooio.com/v2/api`)  |

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
curl -X POST https://backend.blooio.com/v2/api/webhooks \
  -H "Authorization: Bearer $BLOOIO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "webhook_url": "https://your-app.vercel.app/eve/v1/blooio", "webhook_type": "all" }'
```

Blooio signs every delivery with `X-Blooio-Signature: t=<unix>,v1=<hmac_sha256>` over `<t>.<rawBody>`. The channel verifies it in constant time and rejects timestamps older than 5 minutes (configurable via `timestampToleranceSec`).

## How it works

- **Inbound** — A verified `message.received` webhook is parsed and dispatched into the agent. Conversations are sticky to the receiving Blooio line via a continuation token (`blooio:<internalId>:<chatId>`). Group chats route to the group ID; 1:1 chats route to the sender. Delivery-status events (`message.sent`, `message.delivered`, `message.read`, `message.failed`) are acknowledged and ignored.
- **Outbound** — When the agent produces a reply, the default `message.completed` handler sends it back through `POST /chats/{chatId}/messages`. Errors are reported to the conversation.

## Capabilities

The `BlooioHandle` exposed to hooks and event handlers wraps the full Blooio v2 messaging surface:

```ts
export default blooioChannel({
  events: {
    async "message.completed"(event, channel) {
      if (!event.message) return;
      // tapback the user's last message, then reply
      await channel.blooio.react("-1", "+love");
      await channel.blooio.startTyping();
      await channel.blooio.sendMessage(event.message, {
        effect: "confetti", // iMessage send-with-effect
      });
      await channel.blooio.markRead();
    },
  },
});
```

`channel.blooio` supports:

- `sendMessage(text, options?)` — text, attachments, iMessage effects, inline replies, idempotency keys, contact-card sharing, typing indicator
- `react(messageId, reaction, options?)` — add (`+`) or remove (`-`) tapbacks (`love`, `like`, `dislike`, `laugh`, `emphasize`, `question`) or any emoji; supports relative indices (`-1` = last message)
- `startTyping()` / `stopTyping()` — animated typing indicator (iMessage-only)
- `markRead()` — send a read receipt
- `checkCapabilities(contact?)` — check iMessage / SMS / FaceTime support
- `listMessages(options?)` — conversation history with pagination and filters
- `request(method, path, body?, query?)` — raw escape hatch to any Blooio v2 endpoint

## Configuration

| Option                  | Default               | Description                                                        |
| ----------------------- | --------------------- | ------------------------------------------------------------------ |
| `credentials`           | env vars              | `apiKey` and `webhookSecret` (string or async provider)            |
| `route`                 | `/eve/v1/blooio`      | Inbound webhook route                                              |
| `baseUrl`               | Blooio v2 API         | API base URL override                                              |
| `allowFrom`             | `"*"`                 | Exact senders allowed inbound, or `"*"` for all                    |
| `fromNumber`            | inbound `internal_id` | Default sending number for outbound replies                        |
| `markReadOnReceive`     | `false`               | Send a read receipt as soon as a message arrives                  |
| `timestampToleranceSec` | `300`                 | Max webhook signature age                                          |
| `onMessage`             | sender auth           | Inbound hook; return `{ auth }` to dispatch or `null` to drop      |
| `events`                | text delivery         | Override session lifecycle handlers                               |

## Proactive messages

Start a conversation from another channel or a schedule via `receive`:

```ts
await receive(blooio, {
  message: "Your order shipped!",
  target: { chatId: "+15551234567", fromNumber: "+15557654321" },
  auth: null,
});
```

## Thread / continuation tokens

Conversations are keyed as `blooio:<internalId>:<chatId>` so a thread stays bound to a specific Blooio line. Use `blooioContinuationToken(internalId, chatId)` to build them.

## License

MIT © Blooio
