import 'dotenv/config';
import { InstallGlobalCommands } from './utils.js';



const TEST_COMMAND = {
  name: 'test',
  description: 'Basic command',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const SCHEDULED_POST_COMMAND = {
  name: "scheduled_post",
  description: "Schedules a post",
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
  options: [
    {
      type: 7, // channel
      name: "target_channel",
      description: "Channel where the message will be posted",
      required: false, // optional; defaults to the current channel
    },
  ],
};

const ALL_COMMANDS = [TEST_COMMAND, SCHEDULED_POST_COMMAND];

InstallGlobalCommands(process.env.APP_ID, ALL_COMMANDS);
