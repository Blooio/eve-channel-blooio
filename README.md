# eve-channel-blooio

A [Blooio](https://blooio.com) channel for [Vercel eve](https://vercel.com/eve). Send and receive **iMessage, RCS, SMS, and Apple Messages for Business** from your eve agent through the [Blooio v4 API](https://docs.blooio.com). It supports interactive messages (quick replies, list and time pickers, forms), native tapback reactions, typing indicators, read receipts, group chats, polls, capability checks, and history.

eve does not use the Chat SDK runtime, so this is a native eve channel built on `defineChannel`, not a Chat SDK adapter. Drop one file in `agent/channels/` and your agent answers texts.

## Install

```bash
npm install eve-channel-blooio
```

`eve` (and its `ai` peer) are peer dependencies, so install them too if you haven't:

```bash
npm install eve@latest ai
```

### Compatibility

| eve version | Support                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------- |
| 0.69+       | Everything, including the interactive tool ending the turn after it sends                       |
| 0.43 – 0.68 | Everything; the interactive tool works but the model may add a short text after it sends        |
| < 0.43      | Not supported (use `eve-channel-blooio@0.2.0`)                                                  |

Tested against eve 0.48 and 0.76 (latest).

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

One channel file serves every Blooio channel on your account: iMessage/SMS/RCS numbers and Apple Messages for Business brands all deliver to the same webhook, and replies go back out through whichever channel the conversation came in on.

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

- **Inbound** — A verified `message.received` webhook (the v4 envelope `{ id, type, created_at, organization_id, data }`) is parsed and dispatched into the agent with a `<blooio_context>` block (channel type, sender, chat id, and reply guidance). Conversations are sticky to their Blooio chat via a continuation token (`blooio:<chatId>`). Delivery-status and other events (`message.delivered`, `typing.*`, `poll.*`, …) are acknowledged and ignored.
- **Delivery guarantee** — The webhook is acknowledged only after the eve session accepts the message. If `onMessage` throws or the enqueue fails, the route returns a 5xx and Blooio retries the delivery with backoff, so a message is never acknowledged and lost. Delivery is at-least-once: a retry after a lost acknowledgment can redeliver a message, so return `null` from `onMessage` for an already-seen `message.eventId` if you need exactly-once.
- **Inbound attachments** — Images, video, audio, and documents on an inbound message are forwarded to the model as multimodal `UserContent` file parts (one per attachment, alongside any text). Blooio re-hosts inbound media at servable URLs, so they pass straight through to your model provider — no extra download step or `fetchFile` hook required.
- **Outbound** — When the agent produces a reply, the default `message.completed` handler sends it back through `POST /chats/{chatId}/messages`. Errors are reported to the conversation.

## Apple Messages for Business

[Apple Messages for Business](https://docs.blooio.com/guides/apple-messages-for-business) lets customers message your brand from the Messages app, with your logo, name, and a verified checkmark at the top of the thread. On Blooio it is a channel like any other (`channel_type: "amb"`), so this package handles it with the same channel file.

### Connect it

1. Register in [Apple Business Register](https://register.apple.com) and complete Apple's brand verification.
2. Choose **Blooio** as your Messaging Service Provider.
3. In the Blooio dashboard, open **Integrations → Apple Messages for Business** and link your Business ID.
4. Give the channel an alias such as `support`.

Inbound messages then arrive at the same `/eve/v1/blooio` webhook and your agent replies automatically.

### How conversations work

- **Inbound-first.** The customer always starts the conversation from a Messages entry point: your website's Messages button, Apple Maps, Spotlight and Siri, the App Store, or a QR code. Apple gives each customer an opaque id that is scoped to your brand. It is not a phone number. The channel threads on the Blooio chat, so you never handle the id yourself.
- **Agent context.** For these conversations the `<blooio_context>` block reads `channel_type: amb` and `response_medium: apple_messages_for_business`. It also tells the model it can offer interactive choices.
- **Typing indicator.** The default `turn.started` handler shows a typing indicator while the agent works. Apple's Experience Review expects this before bot replies. Apple clears it automatically after 60 seconds.
- **Interactive replies.** When a customer taps a quick reply, picks from a list, chooses a time slot, or submits a form, the message `text` is a readable summary of the choice. The structured answer is on `message.interactiveReply` (`kind`, `chosen`, `responses`, `requestIdentifier`) and in the context block as `interactive_reply` and `interactive_chosen`.
- **Closed chats.** When a customer closes the conversation, Blooio rejects further sends with `409 chat_closed`. Wait for them to message again.

### Let the agent send interactive messages

Add the bundled tool so the model can send quick replies, list pickers, time pickers, and forms:

```ts
// agent/tools/blooio_interactive.ts
import { blooioInteractiveTool } from "eve-channel-blooio/tools";

export default blooioInteractiveTool();
```

The tool's input schema is Blooio's [published JSON Schema for model-generated interactive messages](https://docs.blooio.com/amb-interactive), so the model's output is always a valid interactive object. The tool:

- sends to the current conversation's chat (taken from the session's `chat_id` auth attribute, or the latest `<blooio_context>` block);
- ends the turn after a successful send (eve 0.69+), so the customer's tap arrives as the next message;
- declines on non-Apple Messages for Business conversations and when the device can't render the kind (`422 amb_capability_unavailable`), telling the model to reply in plain text instead.

If you replace `onMessage` with your own auth, keep a `chat_id` attribute (as `defaultBlooioAuth` does) or keep the default context block.

### Send AMB content from code

```ts
export default blooioChannel({
  events: {
    async "message.completed"(event, channel) {
      if (!event.message) return;
      await channel.blooio.sendMessage(event.message);

      if (channel.blooio.isAppleMessagesForBusiness) {
        const kinds = await channel.blooio.supportedInteractiveKinds();
        if (kinds.includes("list_picker")) {
          await channel.blooio.sendInteractive({
            kind: "list_picker",
            received_message: { title: "Choose a service" },
            sections: [
              {
                title: "Services",
                items: [
                  { identifier: "cut", title: "Haircut" },
                  { identifier: "color", title: "Color" },
                ],
              },
            ],
          });
        }
      }
    },
  },
});
```

`sendInteractive` accepts every Blooio interactive kind: `quick_reply`, `list_picker`, `time_picker`, `form`, `apple_pay`, `authenticate` (OAuth 2.0 sign-in), and `imessage_app`. Fields use the [Blooio v4 names](https://docs.blooio.com/amb-interactive) and are forwarded as given.

### Business invitations

The only sanctioned way to start a conversation business-first is an Apple-approved invitation template sent to a phone number that has opted in:

```ts
await channel.blooio.sendInvitation({
  to: "tel:+15551234567",
  from: "support",
  invitation: { template_id: "tmpl_welcome", reference_id: "order-42" },
});
```

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

- `sendMessage(text, options?)` — text and/or public media URLs, with optional `format: "markdown"` (iMessage rich text) and `replyTo`; replies to the bound chat, or routes to the recipient for a proactive conversation
- `sendInteractive(interactive, options?)` — Apple Messages for Business interactive message
- `sendRichLink(url, title?, options?)` — tappable rich link card (iMessage and Apple Messages for Business)
- `sendInvitation({ to, from?, invitation })` — Apple Messages for Business invitation to an opted-in phone number
- `getChat()` / `supportedInteractiveKinds()` — chat state and the interactive kinds the customer's device can render
- `react(messageId, reaction, options?)` — add (`+`) or remove (`-`) tapbacks (`love`, `like`, `dislike`, `laugh`, `emphasize`, `question`) or any emoji
- `startTyping()` / `stopTyping()` — typing indicator (iMessage and Apple Messages for Business)
- `markRead()` — send a read receipt
- `sendPoll(title, options)` — send a native Blooio poll
- `shareContactCard()` — share the sending number's contact card
- `lookupNumber(number?)` — check a phone number's reachability and capabilities (defaults to the sender on phone channels)
- `contactCapabilities(contactId)` — per-identity capabilities for a saved contact (`ct_...`)
- `listMessages(options?)` — conversation history (cursor-paginated)
- `request(method, path, body?, query?)` — raw escape hatch to any Blooio v4 endpoint

It also exposes `chatId`, `to`, `sender`, `isGroup`, `channelType`, and `isAppleMessagesForBusiness`.

## Configuration

| Option                  | Default          | Description                                                   |
| ----------------------- | ---------------- | ------------------------------------------------------------- |
| `credentials`           | env vars         | `apiKey` and `webhookSecret` (string or async provider)       |
| `route`                 | `/eve/v1/blooio` | Inbound webhook route                                         |
| `baseUrl`               | Blooio v4 API    | API base URL override                                         |
| `allowFrom`             | `"*"`            | Exact senders allowed inbound, or `"*"` for all               |
| `fromNumber`            | auto-routing     | Default sender for proactive sends (phone, alias, or `ch_`)   |
| `channelType`           | `blooio`         | Default channel type for routed sends when no `from` is given |
| `markReadOnReceive`     | `false`          | Send a read receipt as soon as a message arrives              |
| `timestampToleranceSec` | `300`            | Max webhook signature age                                     |
| `onMessage`             | sender auth      | Inbound hook; return `{ auth }` to dispatch or `null` to drop |
| `events`                | text delivery    | Override session lifecycle handlers                           |

## Proactive messages

Start a conversation from another channel or a schedule via `receive`. Address a recipient with `to` (a chat is created on first send):

```ts
await receive(blooio, {
  message: "Your order shipped!",
  target: { to: "+15551234567", from: "+15557654321" },
  auth: null,
});
```

On Apple Messages for Business, only target a customer who has already messaged your brand: use their opaque id as `to` and your alias as `from`. To reach someone new, send an invitation.

## Thread / continuation tokens

Inbound conversations are keyed as `blooio:<chatId>` so a thread stays bound to its Blooio chat. Use `blooioContinuationToken(chatId)` to build the channel-local token.

## Releasing

Releases are automated. Bump `version` in `package.json` (`npm version patch|minor|major --no-git-tag-version`) and merge to `main`. The Publish workflow tests, builds, and publishes to npm through [Trusted Publishing](https://docs.npmjs.com/trusted-publishers) with a provenance attestation, then tags `vX.Y.Z` and creates a GitHub release. Prerelease versions (`1.2.0-beta.1`) publish under the `next` tag.

## License

MIT © Blooio
