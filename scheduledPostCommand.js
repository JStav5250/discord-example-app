import {
  InteractionResponseFlags,
  InteractionResponseType,
} from "discord-interactions";
import { DiscordRequest } from "./utils.js";

// In-memory storage of schedules (lost when the bot restarts)
const scheduledPosts = [];

function getOptionValues(options, channel_id) {
  const textOpt = options.find((o) => o.name === "text");;
  const intervalDaysOpt = options.find((o) => o.name === "interval_days");
  const timeOpt = options.find((o) => o.name === "time");
  const targetChannelOpt = options.find((o) => o.name === "target_channel");

  const text = textOpt?.value;
  console.log("intervalDaysOpt", intervalDaysOpt);
  const intervalDays = Number(intervalDaysOpt?.value);
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

function validateOptionValues({ text, intervalDays, timeString, targetChannelId }) {
    if (!text || !intervalDays || !timeString) {
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        flags: InteractionResponseFlags.EPHEMERAL,
        content:
          "Missing options. Usage: `/scheduled_post text:<text> interval_days:<days> time:<HH:MM> [target_channel]`",
      },
    };
  }

  if (!Number.isInteger(intervalDays) || intervalDays < 1) {
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        flags: InteractionResponseFlags.EPHEMERAL,
        content: "interval_days must be an integer >= 1.",
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
          "Time must be in `HH:MM` 24-hour format, e.g. `09:30` or `21:45`.",
      },
    };
  }

  const { hour, minute } = parsedTime;
  return hour, minute; 
}

function calculateTimings(hour, minute, intervalDays) {
  const now = new Date();

  const first = new Date(now.getTime());
  first.setSeconds(0, 0);
  first.setHours(hour, minute, 0, 0);

  if (first <= now) {
    first.setDate(first.getDate() + intervalDays);
  }

  const initialDelayMs = first.getTime() - now.getTime();
  const intervalMs = intervalDays * 24 * 60 * 60 * 1000;
  return { initialDelayMs, intervalMs };
}

async function postMessage(channelId, content) {
  await DiscordRequest(`channels/${channelId}/messages`, {
    method: "POST",
    body: { content },
  });
}

function schedulePostJob({
  initialDelayMs,
  intervalMs,
  targetChannelId,
  text,
  channel_id, // source channel (where command was run)
  intervalDays,
  timeString,
}) {
  // Create a "job" record we will keep in the array
  const job = {
    sourceChannelId: channel_id, // channel where the command was triggered
    targetChannelId, // channel where we will post
    text, // text to post each time
    intervalDays, // how many days between posts
    time: timeString, // "HH:MM" string
    timeoutId: null, // will be filled below
    intervalId: null, // will be filled after first run
  };

  // Schedule the FIRST run
  job.timeoutId = setTimeout(async () => {
    try {
      // First post
      await postMessage(targetChannelId, text);
    } catch (err) {
      console.error("Error during first scheduled post:", err);
    }

    // Then schedule all FUTURE runs
    job.intervalId = setInterval(async () => {
      try {
        await postMessage(targetChannelId, text);
      } catch (err) {
        console.error("Error during scheduled post:", err);
      }
    }, intervalMs);
  }, initialDelayMs);

  // Remember this job so we can inspect/cancel it later
  scheduledPosts.push(job);

  return job;
}

/**
 * Handler for the /repost command.
 * Receives the whole interaction payload and returns the response object.
 */
export async function handleScheduledPostCommand(interaction) {
    const { data, channel_id } = interaction;
    const { options = [] } = data ?? {};

    const { text, intervalDays, timeString, targetChannelId } = getOptionValues(options, channel_id); // 1. Read options
    const { hour, minute } = validateOptionValues({ text, intervalDays, timeString, targetChannelId });   // 2. Basic validation
    const { initialDelayMs, intervalMs } = calculateTimings(hour, minute, intervalDays); // 4. Calculate timings

    console.log(`Scheduling post of message to ${targetChannelId} every ${intervalDays} day(s) at ${timeString}`);

    // 5. Schedule the job (first run + repeats) with one helper
    const job = schedulePostJob({
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
            content: `Scheduled repost of message to <#${targetChannelId}> every **${intervalDays}** day(s) at **${timeString}** (server time).`,
        },
    };
}

// Export this in case you later want to inspect or cancel schedules.
export { scheduledPosts };