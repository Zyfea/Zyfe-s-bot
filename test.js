// Import necessary modules and dependencies
import {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  Colors,
} from "discord.js";
import mongoose from "mongoose";
import fetch from "node-fetch";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { imageHash } from "image-hash";

// Load environment variables
dotenv.config();

// Handle file paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// -----------------------------------------------------------------------------
/* MONGOOSE SCHEMAS (Unchanged)
 */
// -----------------------------------------------------------------------------

// 1) Image Schema:
const imageSchema = new mongoose.Schema(
  {
    hash: { type: String },
    guildId: { type: String, index: true },
    channelId: String,
    messageId: String,
    url: String,
  },
  { timestamps: true }
);
imageSchema.index({ hash: 1, guildId: 1 }, { unique: true });
const Image = mongoose.model("Image", imageSchema);

// 2) GuildConfig Schema:
const guildSchema = new mongoose.Schema({
  guildId: { type: String, unique: true },
  activeChannelId: String,
  botCommandChannelId: String,
});
const GuildConfig = mongoose.model("GuildConfig", guildSchema);

// -----------------------------------------------------------------------------
/* DISCORD CLIENT SETUP (Unchanged)
 */
// -----------------------------------------------------------------------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Message, Partials.Channel],
});

// Flag to track if the bot is running
let botRunning = true;

// -----------------------------------------------------------------------------
/* MONGODB CONNECTION (Unchanged)
 */
// -----------------------------------------------------------------------------

const connectToDatabase = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("✅ Connected to MongoDB.");
  } catch (err) {
    console.error("❌ Failed to connect to MongoDB:", err);
    setTimeout(connectToDatabase, 5000); // Retry after 5 seconds
  }
};
connectToDatabase();

// -----------------------------------------------------------------------------
/* UTILITY: Compute Image Hash (Unchanged)
 */
// -----------------------------------------------------------------------------

const computeImageHash = async (url) => {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.statusText}`);
    }

    const imageUrl = response.url;

    return new Promise((resolve) => {
      imageHash(imageUrl, 16, true, (error, data) => {
        if (error) {
          console.error("🔴 Error computing image hash:", error);
          return resolve(null);
        }
        resolve(data);
      });
    });
  } catch (error) {
    console.error("🔴 Error computing image hash:", error);
    return null;
  }
};

// -----------------------------------------------------------------------------
/* DISCORD: Client Event Handlers (Modified)
 */
// -----------------------------------------------------------------------------

// 1) On Client Ready (Unchanged)
client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}!`);
});

// 2) On Message Create (Modified)
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;

    const guildConfig = await GuildConfig.findOne({
      guildId: message.guild.id,
    });

    // ---------------------------------------
    //  Setup Command: "!setup <activeChannelId> <botCommandChannelId>"
    // ---------------------------------------
    if (message.content.startsWith("!setup")) {
      // Must be admin
      if (
        !message.member.permissions.has(PermissionsBitField.Flags.Administrator)
      ) {
        await message.reply("❌ Only administrators can run this command.");
        return;
      }

      // Command format
      const [_, activeChannelId, botCommandChannelId] =
        message.content.split(" ");

      if (!activeChannelId || !botCommandChannelId) {
        await message.reply(
          "❌ Usage: `!setup <activeChannelId> <botCommandChannelId>`"
        );
        return;
      }

      // Save or update the guild config
      await GuildConfig.findOneAndUpdate(
        { guildId: message.guild.id },
        { guildId: message.guild.id, activeChannelId, botCommandChannelId },
        { upsert: true }
      );

      await message.reply("✅ Configuration saved successfully.");
      console.log(`✅ Setup completed for guild: ${message.guild.id}`);
      return;
    }

    // If guild not configured, ignore everything else
    if (!guildConfig) return;

    const { activeChannelId, botCommandChannelId } = guildConfig;

    // Only process images in the "active" channel
    if (message.channel.id !== activeChannelId) return;

    // ---------------------------------------
    //  Start and Stop Bot: "!startbot" or "!stopbot"
    // ---------------------------------------
    if (
      message.content.startsWith("!startbot") ||
      message.content.startsWith("!stopbot")
    ) {
      // Must be admin
      if (
        !message.member.permissions.has(PermissionsBitField.Flags.Administrator)
      ) {
        await message.reply(
          "❌ You do not have permission to run this command."
        );
        return;
      }

      // Toggle botRunning
      if (message.content.startsWith("!startbot")) {
        botRunning = true;
        await message.reply("✅ The bot is now running.");
        console.log("✅ Bot started.");
      } else {
        botRunning = false;
        await message.reply("🛑 The bot has been stopped.");
        console.log("🛑 Bot stopped.");
      }
      return;
    }

    // If the bot is "stopped," ignore image processing
    if (!botRunning) return;

    // ---------------------------------------
    //  Collect Images (Attachments + Embeds)
    // ---------------------------------------
    let imageUrls = [];

    // 1) Attachments
    message.attachments.forEach((attachment) => {
      if (
        attachment.contentType &&
        attachment.contentType.startsWith("image/") &&
        attachment.url
      ) {
        imageUrls.push(attachment.url);
      }
    });

    // 2) Embeds
    message.embeds.forEach((embed) => {
      if (embed.image && embed.image.url) {
        imageUrls.push(embed.image.url);
      }
    });

    // If no images found, stop
    if (imageUrls.length === 0) return;

    console.log(`🔍 Checking ${imageUrls.length} image(s)...`);

    // ---------------------------------------
    //  Process Each Image
    // ---------------------------------------
    for (const imageUrl of imageUrls) {
      // Compute hash
      const hash = await computeImageHash(imageUrl);
      if (!hash) continue; // skip if no hash

      console.log(`🔑 Image hash computed: ${hash}`);

      try {
        // Attempt upsert
        const existingImage = await Image.findOneAndUpdate(
          { hash, guildId: message.guild.id },
          {
            $setOnInsert: {
              channelId: message.channel.id,
              messageId: message.id,
              url: imageUrl,
            },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        // Determine if it was newly inserted or updated
        const wasInserted =
          existingImage.createdAt &&
          existingImage.createdAt.getTime() ===
            existingImage.updatedAt.getTime();

        if (wasInserted) {
          // New image
          console.log(`✅ Saved new image hash for ${message.author.tag}`);
        } else {
          // Duplicate image => handle penalty
          console.log("⚠️ Duplicate image detected, handling as duplicate.");

          // 1) Find the 'CODE CERTIFIED' role
          const codeCertifiedRole = message.guild.roles.cache.find(
            (role) => role.name === "CODE CERTIFIED"
          );

          if (!codeCertifiedRole) {
            console.error(
              "🔴 'CODE CERTIFIED' role does not exist in the guild."
            );
            // Optionally, notify administrators or log this event
            continue; // Skip further processing if role doesn't exist
          }

          // 2) Remove 'CODE CERTIFIED' role from user
          if (message.member.roles.cache.has(codeCertifiedRole.id)) {
            try {
              await message.member.roles.remove(codeCertifiedRole);
              console.log(
                `✅ Removed 'CODE CERTIFIED' role from ${message.author.tag}.`
              );
            } catch (err) {
              console.error("🔴 Failed to remove 'CODE CERTIFIED' role:", err);
            }
          } else {
            console.log(
              `ℹ️ User ${message.author.tag} does not have the 'CODE CERTIFIED' role.`
            );
          }

          // 3) Delete the duplicate message
          try {
            await message.delete();
            console.log("🗑️ Deleted duplicate message.");
          } catch (err) {
            console.error("🔴 Error deleting duplicate message:", err);
          }

          // 4) Construct the link to the *original* image
          const originalLink = `https://discord.com/channels/${existingImage.guildId}/${existingImage.channelId}/${existingImage.messageId}`;

          // 5) Notify user via DM
          try {
            await message.author.send(
              "Your image was removed because it was identified as a duplicate based on its content or name. Please resubmit a new Orginal Image to receive 'CODE CERTIFIED' to participate in giveaways 🎉"            );
            console.log(
              `📩 Sent DM to ${message.author.tag} about duplicate image.`
            );
          } catch (err) {
            console.log("🔴 Could not send DM to user:", err);
          }

          // 6) Notify the bot command channel
          try {
            const botCommandChannel = await message.guild.channels.fetch(
              botCommandChannelId
            );
            if (botCommandChannel) {
              await botCommandChannel.send(
                "Your image was removed because it was identified as a duplicate based on its content or name. Please resubmit a new Orginal Image to receive 'CODE CERTIFIED' to participate in giveaways 🎉"              );
              console.log("📢 Sent notification to bot command channel.");
            }
          } catch (err) {
            console.error(
              "🔴 Failed to send notification to bot command channel:",
              err
            );
          }
        }
      } catch (err) {
        // --------------------------------------------------
        // DUPLICATE KEY ERROR (E11000)
        // --------------------------------------------------
        if (err.code === 11000) {
          console.log(
            "⚠️ Duplicate key error detected, handling as duplicate."
          );

          // Check if we can fetch the existing record
          const existingImage = await Image.findOne({
            hash: hash,
            guildId: message.guild.id,
          });

          if (existingImage) {
            // Same penalty logic
            const codeCertifiedRole = message.guild.roles.cache.find(
              (role) => role.name === "CODE CERTIFIED"
            );

            if (!codeCertifiedRole) {
              console.error(
                "🔴 'CODE CERTIFIED' role does not exist in the guild."
              );
              // Optionally, notify administrators or log this event
              continue; // Skip further processing if role doesn't exist
            }

            // Remove 'CODE CERTIFIED' role from user if they have it
            if (message.member.roles.cache.has(codeCertifiedRole.id)) {
              try {
                await message.member.roles.remove(codeCertifiedRole);
                console.log(
                  `✅ Removed 'CODE CERTIFIED' role from ${message.author.tag}.`
                );
              } catch (error) {
                console.error(
                  "🔴 Failed to remove 'CODE CERTIFIED' role:",
                  error
                );
              }
            } else {
              console.log(
                `ℹ️ User ${message.author.tag} does not have the 'CODE CERTIFIED' role.`
              );
            }

            // Delete the duplicate message
            try {
              await message.delete();
              console.log("🗑️ Deleted duplicate message.");
            } catch (error) {
              console.error("🔴 Error deleting duplicate message:", error);
            }

            // Construct original link
            const originalLink = `https://discord.com/channels/${existingImage.guildId}/${existingImage.channelId}/${existingImage.messageId}`;

            // DM the user
            try {
              await message.author.send(
                "Your image was removed because it was identified as a duplicate based on its content or name. Please resubmit a new Orginal Image to receive 'CODE CERTIFIED' to participate in giveaways 🎉"
              );
              console.log(
                `📩 Sent DM to ${message.author.tag} about duplicate image.`
              );
            } catch (error) {
              console.log("🔴 Could not send DM to user:", error);
            }

            // Notify the bot command channel
            try {
              const botCommandChannel = await message.guild.channels.fetch(
                botCommandChannelId
              );
              if (botCommandChannel) {
                await botCommandChannel.send(
                  "Your image was removed because it was identified as a duplicate based on its content or name. Please resubmit a new Orginal Image to receive 'CODE CERTIFIED' to participate in giveaways 🎉"                );
                console.log("📢 Sent notification to bot command channel.");
              }
            } catch (error) {
              console.error(
                "🔴 Failed to send notification to bot command channel:",
                error
              );
            }
          } else {
            // The existing record isn't found — can happen due to race conditions
            console.error(
              "🔴 Duplicate key error but existing image not found."
            );
          }
        } else {
          // Some other error
          console.error("🔴 Error saving new image hash:", err);
        }
      }
    }
  } catch (error) {
    console.error("🔴 Unexpected error in messageCreate event:", error);
  }
});

// 3) On Message Delete (Unchanged)
client.on("messageDelete", async (message) => {
  try {
    const imageRecord = await Image.findOne({
      messageId: message.id,
      guildId: message.guild.id,
    });
    if (imageRecord) {
      await Image.deleteOne({ messageId: message.id });
      console.log(
        `🗑️ Deleted image record from database for message ${message.id}`
      );
    }
  } catch (error) {
    console.error("🔴 Error deleting image record:", error);
  }
});

// -----------------------------------------------------------------------------
/* GRACEFUL SHUTDOWN (Unchanged)
 */
// -----------------------------------------------------------------------------

process.on("SIGINT", async () => {
  console.log("🔴 Bot is shutting down gracefully...");
  await mongoose.disconnect();
  client.destroy();
  process.exit(0);
});

// -----------------------------------------------------------------------------
/* LOGIN (Unchanged)
 */
// -----------------------------------------------------------------------------

client.login(process.env.DISCORD_TOKEN);
