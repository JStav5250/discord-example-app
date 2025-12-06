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

// Allow you to type "\n" in the command and get real newlines in the message.
function normalizeText(raw) {
  if (typeof raw !== "string") return raw;
  // "\\n" in the string → actual newline
  return raw.replace(/\\n/g, "\n");
}

function getOptionValues(options, channel_id) {
  const textOpt = options.find((o) => o.name === "text");
  const intervalDaysOpt = options.find((o) => o.name === "interval_days");
  const timeOpt = options.find((o) => o.name === "time");
  const targetChannelOpt = options.find((o) => o.name === "target_channel");

  const text = textOpt?.value;
  const intervalDays =
    intervalDaysOpt?.value !== undefined ? Number(intervalDaysOpt.value) : NaN;
  const timeString = timeOpt?.value;
  const targetChannelId = targetChannelOpt?.value || channel_id;

  return { text, intervalDays, timeString, targetChannelId };
}

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
 * Validate the basic option values.
 * On error: returns a complete interaction response object.
 * On success: returns { hour, minute }.
 *
 * NOTE: Times are interpreted in the local timezone of the machine
 * (you said EST, so your OS should be set to Eastern Time).
 */
function validateOptionValues({ text, intervalDays, timeString }) {
  // Missing or empty text
  if (!text || typeof text !== "string" || text.trim() === "") {
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        flags: InteractionResponseFlags.EPHEMERAL,
        content:
          "You must provide some text to post. Usage: `/scheduled_post text:<text> interval_days:<days> time:<HH:MM> [target_channel]` (time in Eastern Time).",
      },
    };
  }

  // interval_days:
  //  - integer >= 1  → repeat every N days
  //  - integer === 0 → one-time post at the next occurrence of that time
  if (
    intervalDays === undefined ||
    Number.isNaN(intervalDays) ||
    !Number.isInteger(intervalDays) ||
    intervalDays < 0
  ) {
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        flags: InteractionResponseFlags.EPHEMERAL,
        content:
          "interval_days must be an integer >= 0. Use 0 to post once at the chosen time.",
      },
    };
  }

  // Missing/invalid time
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
  return { hour, minute };
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
  channel_id, // source channel (where command was run)
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

    // Only create a repeating interval if intervalMs > 0 (interval_days > 0)
    if (intervalMs > 0) {
      job.intervalId = setInterval(async () => {
        try {
          await postMessage(targetChannelId, text);
        } catch (err) {
          console.error("Error during scheduled post:", err);
        }
      }, intervalMs);
    } else {
      // one-time job: no repeats; you could also remove it from scheduledPosts here if you want
      job.timeoutId = null;
    }
  }, initialDelayMs);

  scheduledPosts.push(job);
  return job;
}

/**
 * Handler for the /scheduled_post command.
 * Example:
 *   /scheduled_post text:"Line 1\\nLine 2" interval_days:7 time:19:30
 *   → posts with an actual line break between Line 1 and Line 2.
 */
export async function handleScheduledPostCommand(interaction) {
  const { data, channel_id } = interaction;
  const { options = [] } = data ?? {};

  // 1. Read raw options from Discord
  const {
    text: rawText,
    intervalDays,
    timeString,
    targetChannelId,
  } = getOptionValues(options, channel_id);

  // 2. Normalize text (interpret "\n" as real newlines)
  const text = normalizeText(rawText);

  // 3. Basic validation
  const validationResult = validateOptionValues({
    text,
    intervalDays,
    timeString,
  });

  if (validationResult && validationResult.type && validationResult.data) {
    return validationResult;
  }

  const { hour, minute } = validationResult;

  // 4. Calculate timings
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

  // 5. Schedule the job (first run + maybe repeats)
  schedulePostJob({
    initialDelayMs,
    intervalMs,
    targetChannelId,
    text,
    channel_id,
    intervalDays,
    timeString,
  });

  // 6. Return an ephemeral acknowledgement
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