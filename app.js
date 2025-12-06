import "dotenv/config";
import express from "express";
import {
  InteractionResponseType,
  InteractionType,
  verifyKeyMiddleware,
} from "discord-interactions";
import { handleTestCommand } from "./testCommand.js";
import {
  handleScheduledPostCommand,
  handleScheduledPostModalSubmit,
} from "./scheduledPostCommand.js";

// Create an express app
const app = express();
// Get port, or default to 3000
const PORT = process.env.PORT || 3000;

/**
 * Interactions endpoint URL where Discord will send HTTP requests
 */
app.post(
  "/interactions",
  verifyKeyMiddleware(process.env.PUBLIC_KEY),
  async function (req, res) {
    const { type, data } = req.body;

    // 1) Discord "ping" check
    if (type === InteractionType.PING) {
      return res.send({ type: InteractionResponseType.PONG });
    }

    // 2) Slash command interactions
    if (type === InteractionType.APPLICATION_COMMAND) {
      const { name } = data ?? {};

      // /test
      if (name === "test") {
        const response = handleTestCommand();
        return res.send(response);
      }

      // /scheduled_post  -> opens the modal
      if (name === "scheduled_post") {
        const response = await handleScheduledPostCommand(req.body);
        return res.send(response);
      }

      console.error(`unknown command: ${name}`);
      return res.status(400).json({ error: "unknown command" });
    }

    // 3) Modal submit interactions (when user submits the scheduled_post modal)
    if (type === InteractionType.MODAL_SUBMIT) {
      const { custom_id } = data ?? {};

      // Our scheduled post modal
      if (custom_id && custom_id.startsWith("scheduled_post_modal|")) {
        const response = await handleScheduledPostModalSubmit(req.body);
        return res.send(response);
      }

      console.error(`unknown modal submit: ${custom_id}`);
      return res.status(400).json({ error: "unknown modal submit" });
    }

    console.error("unknown interaction type", type);
    return res.status(400).json({ error: "unknown interaction type" });
  }
);

app.listen(PORT, () => {
  console.log("Listening on port", PORT);
});