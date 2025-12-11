import {
  InteractionResponseFlags,
  InteractionResponseType,
} from "discord-interactions";
import { DiscordRequest } from "./utils.js";

// In-memory storage of schedules (lost when the bot restarts)
const scheduledPosts = [];

// ---------------------------------------------------------
// Helpers
// ---------------------------------------------------------

// Allow you to type "\\n" literally and get real newlines.
function normalizeText(raw) {
  if (typeof raw !== "string") return raw;
  return raw.replace(/\\n/g, "\n");
}

/**
 * Parse "HH:MM" 24-hour time.
 * Returns { hour, minute } on success, or null on failure.
 */
function parseTimeString(timeStr) {
  if (!timeStr) return null;
  const match = timeStr.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (
    Number.isNaN(hour) ||
    Number.isNaN(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  return { hour, minute };
}

/**
 * Parse interval_days from a string.
 * Must be an integer >= 0.
 */
function parseIntervalDays(raw) {
  if (raw == null) return NaN;
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 0) return NaN;
  return n;
}

/**
 * Get a text input value from modal components by custom_id.
 */
function getTextInputValue(components, wantedId) {
  if (!Array.isArray(components)) return undefined;

  for (const row of components) {
    const rowComponents = row.components || [];
    for (const input of rowComponents) {
      if (input?.custom_id === wantedId) {
        return input.value;
      }
    }
  }
  return undefined;
}

/**
 * Validate values coming from the modal:
 *  - text (message content)
 *  - intervalDaysStr (string)
 *  - timeString
 *
 * On error: returns a full interaction response (ephemeral).
 * On success: returns { intervalDays, hour, minute }.
 */
function validateModalValues({ text, intervalDaysStr, timeString }) {
  // Text
  if (!text || typeof text !== "string" || text.trim() === "") {
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        flags: InteractionResponseFlags.EPHEMERAL,
        content:
          "You must provide some text to post in the modal. The message cannot be empty.",
      },
    };
  }

  // interval_days
  const intervalDays = parseIntervalDays(intervalDaysStr);
  if (Number.isNaN(intervalDays)) {
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        flags: InteractionResponseFlags.EPHEMERAL,
        content:
          '"Interval (days)" must be an integer >= 0. Use 0 to post once at the chosen time.',
      },
    };
  }

  // time
  if (!timeString) {
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        flags: InteractionResponseFlags.EPHEMERAL,
        content:
          "You must provide a time. Time must be in `HH:MM` 24-hour format (Eastern Time), e.g. `09:30` or `21:45`.",
      },
    };
  }

  const parsedTime = parseTimeString(timeString);
  if (!parsedTime) {
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        flags: InteractionResponseFlags.EPHEMERAL,
        content:
          "Time must be in `HH:MM` 24-hour format (Eastern Time), e.g. `09:30` or `21:45`.",
      },
    };
  }

  const { hour, minute } = parsedTime;
  return { intervalDays, hour, minute };
}

/**
 * Calculate when to first run and how often to repeat.
 *
 * - For intervalDays > 0:
 *   * First run: next occurrence of time, at least intervalDays days offset if needed.
 *   * Repeat: every intervalDays days.
 *
 * - For intervalDays === 0 (one-shot):
 *   * First run: next occurrence of that time (today if future, otherwise tomorrow).
 *   * No repeat.
 */
function calculateTimings(hour, minute, intervalDays) {
  const now = new Date();

  const first = new Date(now.getTime());
  first.setSeconds(0, 0);
  first.setHours(hour, minute, 0, 0);

  if (first <= now) {
    if (intervalDays > 0) {
      // repeating job: jump ahead by intervalDays
      first.setDate(first.getDate() + intervalDays);
    } else {
      // one-shot job with time already passed today → schedule for tomorrow
      first.setDate(first.getDate() + 1);
    }
  }

  const initialDelayMs = first.getTime() - now.getTime();
  const intervalMs =
    intervalDays > 0 ? intervalDays * 24 * 60 * 60 * 1000 : 0;

  return { initialDelayMs, intervalMs };
}

async function postMessage(channelId, content) {
  await DiscordRequest(`channels/${channelId}/messages`, {
    method: "POST",
    body: { content },
  });
}

/**
 * Creates and registers a scheduled job in memory.
 *
 * - If intervalMs > 0 → one timeout for first run + interval for repeats.
 * - If intervalMs === 0 → only one timeout (one-time post).
 */
function schedulePostJob({
  initialDelayMs,
  intervalMs,
  targetChannelId,
  text,
  channel_id, // source channel (where command / modal was run)
  intervalDays,
  timeString,
}) {
  const job = {
    sourceChannelId: channel_id,
    targetChannelId,
    text,
    intervalDays,
    time: timeString,
    timeoutId: null,
    intervalId: null,
  };

  job.timeoutId = setTimeout(async () => {
    try {
      await postMessage(targetChannelId, text);
    } catch (err) {
      console.error("Error during first scheduled post:", err);
    }

    if (intervalMs > 0) {
      job.intervalId = setInterval(async () => {
        try {
          await postMessage(targetChannelId, text);
        } catch (err) {
          console.error("Error during scheduled post:", err);
        }
      }, intervalMs);
    } else {
      job.timeoutId = null;
    }
  }, initialDelayMs);

  scheduledPosts.push(job);
  return job;
}

// ---------------------------------------------------------
// Modal builder
// ---------------------------------------------------------

/**
 * Modal: interval_days + time + message text.
 * targetChannelId is *not* editable here, it’s passed via custom_id.
 */
function buildScheduledPostModal({ targetChannelId }) {
  // IMPORTANT: prefix is "scheduled_post_modal|" to match typical routing
  const customId = `scheduled_post_modal|${targetChannelId}`;

  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: customId,
      title: "Create Scheduled Post",
      components: [
        {
          type: 1, // ACTION_ROW
          components: [
            {
              type: 4, // TEXT_INPUT
              custom_id: "interval_days_input",
              style: 1, // SHORT
              label: "Interval (days, 0 for one-time)",
              min_length: 1,
              max_length: 4,
              required: true,
              placeholder: "e.g. 0 or 7",
            },
          ],
        },
        {
          type: 1,
          components: [
            {
              type: 4,
              custom_id: "time_input",
              style: 1, // SHORT
              label: "Time (HH:MM, 24-hour, Eastern Time)",
              min_length: 4,
              max_length: 5,
              required: true,
              placeholder: "e.g. 19:30",
            },
          ],
        },
        {
          type: 1,
          components: [
            {
              type: 4,
              custom_id: "scheduled_post_text",
              style: 2, // PARAGRAPH
              label: "Message to schedule",
              min_length: 1,
              max_length: 2000,
              required: true,
              placeholder:
                "Type your Discord message here.\nMarkdown and line breaks are supported.",
            },
          ],
        },
      ],
    },
  };
}

// ---------------------------------------------------------
// Handlers
// ---------------------------------------------------------

/**
 * /scheduled_post command:
 *
 *  - Optional slash option: target_channel (CHANNEL)
 *  - interval_days + time + text are collected in the modal.
 */
export async function handleScheduledPostCommand(interaction) {
  const { data, channel_id } = interaction;
  const { options = [] } = data ?? {};

  // Only option: target_channel (optional)
  const targetChannelOpt = options.find((o) => o.name === "target_channel");
  const targetChannelId = targetChannelOpt?.value || channel_id;

  // Open the modal; all other data is collected there
  return buildScheduledPostModal({ targetChannelId });
}

/**
 * Modal submit handler:
 * Reads interval_days, time, text from the modal,
 * and uses targetChannelId passed via custom_id.
 */
export async function handleScheduledPostModalSubmit(interaction) {
  const { data, channel_id } = interaction;
  const { custom_id, components } = data;

  // custom_id format: scheduled_post_modal|targetChannelId
  if (!custom_id || !custom_id.startsWith("scheduled_post_modal|")) {
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        flags: InteractionResponseFlags.EPHEMERAL,
        content: "Unknown modal.",
      },
    };
  }

  const [, targetChannelId] = custom_id.split("|");

  const intervalDaysStr = getTextInputValue(components, "interval_days_input");
  const timeString = getTextInputValue(components, "time_input");
  const rawText = getTextInputValue(components, "scheduled_post_text");

  if (intervalDaysStr == null || timeString == null || rawText == null) {
    console.error("Modal components missing:", { components });
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        flags: InteractionResponseFlags.EPHEMERAL,
        content:
          "Something went wrong reading the modal data. Please try again.",
      },
    };
  }

  const text = normalizeText(rawText);

  const validationResult = validateModalValues({
    text,
    intervalDaysStr,
    timeString,
  });

  if (validationResult && validationResult.type && validationResult.data) {
    return validationResult; // error response
  }

  const { intervalDays, hour, minute } = validationResult;

  const { initialDelayMs, intervalMs } = calculateTimings(
    hour,
    minute,
    intervalDays
  );

  const scheduleDescription =
    intervalDays === 0
      ? `once at **${timeString}** Eastern Time.`
      : `every **${intervalDays}** day(s) at **${timeString}** Eastern Time.`;

  console.log(
    `Scheduling post to ${targetChannelId} ${scheduleDescription} Text:`,
    text
  );

  schedulePostJob({
    initialDelayMs,
    intervalMs,
    targetChannelId,
    text,
    channel_id,
    intervalDays,
    timeString,
  });

  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: InteractionResponseFlags.EPHEMERAL,
      content: `Scheduled post to <#${targetChannelId}> ${scheduleDescription}`,
    },
  };
}

// Export this in case you later want to inspect or cancel schedules.
export { scheduledPosts };