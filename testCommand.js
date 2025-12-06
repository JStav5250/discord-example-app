// testCommand.js
import {
  InteractionResponseFlags,
  InteractionResponseType,
  MessageComponentTypes,
} from "discord-interactions";
import { getRandomEmoji } from "./utils.js";

/**
 * Handler for the /test command.
 * Returns the interaction response object that app.js will send.
 */
export function handleTestCommand() {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: InteractionResponseFlags.IS_COMPONENTS_V2,
      components: [
        {
          type: MessageComponentTypes.TEXT_DISPLAY,
          content: `hello world ${getRandomEmoji()}`,
        },
      ],
    },
  };
}