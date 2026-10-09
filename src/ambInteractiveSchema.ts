/**
 * JSON Schema for model-generated Apple Messages for Business interactive
 * objects, as published at https://docs.blooio.com/amb-interactive
 * ("Structured output for AI agents"). Covers the kinds a model can author
 * safely: quick_reply, list_picker, time_picker, and form.
 */

const bubble = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    subtitle: { type: "string" },
    style: { type: "string", enum: ["icon", "small", "large"] },
  },
};

const quickReply = {
  title: "quick_reply",
  type: "object",
  required: ["kind", "summary_text", "items"],
  additionalProperties: false,
  properties: {
    kind: { const: "quick_reply" },
    summary_text: { type: "string", description: "Prompt shown above the options." },
    items: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      items: {
        type: "object",
        required: ["id", "title"],
        additionalProperties: false,
        properties: {
          id: { type: "string", description: "Stable option id returned on the reply." },
          title: { type: "string", description: "Short tappable label." },
        },
      },
    },
  },
};

const listPicker = {
  title: "list_picker",
  type: "object",
  required: ["kind", "sections"],
  additionalProperties: false,
  properties: {
    kind: { const: "list_picker" },
    received_message: { $ref: "#/$defs/bubble" },
    reply_message: { $ref: "#/$defs/bubble" },
    sections: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["title", "items"],
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          multipleSelection: { type: "boolean" },
          items: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["identifier", "title"],
              additionalProperties: false,
              properties: {
                identifier: { type: "string" },
                title: { type: "string" },
                subtitle: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
};

const timePicker = {
  title: "time_picker",
  type: "object",
  required: ["kind", "event"],
  additionalProperties: false,
  properties: {
    kind: { const: "time_picker" },
    received_message: { $ref: "#/$defs/bubble" },
    reply_message: { $ref: "#/$defs/bubble" },
    event: {
      type: "object",
      required: ["title", "timeslots"],
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        location: {
          type: "object",
          additionalProperties: false,
          properties: { title: { type: "string" } },
        },
        timeslots: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["startTime", "duration"],
            additionalProperties: false,
            properties: {
              startTime: { type: "string", description: "ISO-8601, e.g. 2026-07-20T17:00:00Z." },
              duration: { type: "integer", description: "Slot length in seconds." },
            },
          },
        },
      },
    },
  },
};

const form = {
  title: "form",
  type: "object",
  required: ["kind", "dynamic"],
  additionalProperties: false,
  properties: {
    kind: { const: "form" },
    received_message: { $ref: "#/$defs/bubble" },
    reply_message: { $ref: "#/$defs/bubble" },
    dynamic: {
      type: "object",
      description: "Apple dynamic interactive message, forwarded verbatim. Uses Apple's field names.",
      required: ["startPageIdentifier", "pages"],
      additionalProperties: true,
      properties: {
        startPageIdentifier: { type: "string" },
        showSummary: { type: "boolean" },
        pages: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["pageIdentifier", "title"],
            additionalProperties: true,
            properties: {
              pageIdentifier: { type: "string" },
              title: { type: "string" },
              subtitle: { type: "string" },
              nextPageIdentifier: { type: "string" },
              textInputs: {
                type: "array",
                items: {
                  type: "object",
                  required: ["identifier", "title"],
                  additionalProperties: true,
                  properties: {
                    identifier: { type: "string" },
                    title: { type: "string" },
                    type: { type: "string", description: "Apple input type, e.g. text, name, email, phone." },
                  },
                },
              },
              datePicker: {
                type: "object",
                required: ["identifier", "title"],
                additionalProperties: true,
                properties: {
                  identifier: { type: "string" },
                  title: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
  },
};

/** Tool input schema: `{ interactive }`, one of the four model-authorable kinds. */
export const AMB_INTERACTIVE_TOOL_INPUT_SCHEMA = {
  type: "object",
  required: ["interactive"],
  additionalProperties: false,
  properties: {
    interactive: {
      description:
        "Apple Messages for Business interactive object. Choose exactly one kind and fill only that kind's fields.",
      type: "object",
      oneOf: [quickReply, listPicker, timePicker, form],
    },
  },
  $defs: { bubble },
};
