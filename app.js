import "dotenv/config";
import express from "express";
import {
  InteractionResponseType,
  InteractionType,
  verifyKeyMiddleware,
} from "discord-interactions";
import { handleTestCommand } from "./testCommand.js";
import { handleScheduledPostCommand } from "./scheduledPostCommand.js";

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

      // /repost
      if (name === "scheduled_post") {
        const response = await handleScheduledPostCommand(req.body);
        return res.send(response);
      }

      console.error(`unknown command: ${name}`);
      return res.status(400).json({ error: "unknown command" });
    }

    console.error("unknown interaction type", type);
    return res.status(400).json({ error: "unknown interaction type" });
  }
);

app.listen(PORT, () => {
  console.log("Listening on port", PORT);
});