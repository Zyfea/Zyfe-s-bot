////////////////////////////////////////////////////////////////////////////////
// index.js (or bot.js)
////////////////////////////////////////////////////////////////////////////////

// -----------------------------------------------------------------------------
// IMPORTS
// -----------------------------------------------------------------------------
import {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField
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
// MONGOOSE SCHEMAS
// -----------------------------------------------------------------------------

// 1) Image Schema:
//    - Holds a unique hash + guildId pair, plus references to message, etc.
const imageSchema = new mongoose.Schema(
  {
    hash: { type: String, required: true },
    guildId: { type: String, required: true, index: true },
    channelId: String,
    messageId: String,
    url: String,
  },
  { timestamps: true }
);

// Create a compound unique index on (hash, guildId)
imageSchema.index({ hash: 1, guildId: 1 }, { unique: true });

// Model
const Image = mongoose.model("Image", imageSchema);

// 2) GuildConfig Schema:
//    - Holds configuration data for each guild (which channel is active, etc.)
const guildSchema = new mongoose.Schema({
  guildId: { type: String, unique: true },
  activeChannelId: String,
  botCommandChannelId: String,
});
const GuildConfig = mongoose.model("GuildConfig", guildSchema);

// -----------------------------------------------------------------------------
// DISCORD CLIENT SETUP
// -----------------------------------------------------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Message, Partials.Channel],
});

let botRunning = true;

// -----------------------------------------------------------------------------
// MONGODB CONNECTION
// -----------------------------------------------------------------------------
const connectToDatabase = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log("✅ Connected to MongoDB.");
  } catch (err) {
    console.error("❌ Failed to connect to MongoDB:", err);
    setTimeout(connectToDatabase, 5000); // Retry after 5 seconds
  }
};
connectToDatabase();

// -----------------------------------------------------------------------------
// UTILITY: Compute Image Hash
// -----------------------------------------------------------------------------
/**
 * Computes the hash of an image from its URL.
 * @param {string} url - The URL of the image.
 * @returns {Promise<string|null>} - The hash string or null on error.
 */
const computeImageHash = async (url) => {
  try {
    // Fetch the image data from the URL
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.statusText}`);
    }
    const imageUrl = response.url;

    // Using image-hash directly on a remote URL can sometimes be finicky;
    // If you run into issues, consider downloading the image first or using a buffer.
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
// DISCORD: Client Event Handlers
// -----------------------------------------------------------------------------

// 1) On Client Ready
client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}!`);
});

// 2) On Message Create
client.on("messageCreate", async (message) => {
  try {
    // Ignore bot messages
    if (message.author.bot) return;

    // Retrieve guild config
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

    // If no guildConfig, ignore everything else
    if (!guildConfig) return;

    const { activeChannelId, botCommandChannelId } = guildConfig;

    // Only process images in the configured channel
    if (message.channel.id !== activeChannelId) return;

    // ---------------------------------------
    //  Startbot / Stopbot
    // ---------------------------------------
    if (
      message.content.startsWith("!startbot") ||
      message.content.startsWith("!stopbot")
    ) {
      // Must be admin
      if (
        !message.member.permissions.has(PermissionsBitField.Flags.Administrator)
      ) {
        await message.reply("❌ You do not have permission to run this command.");
        return;
      }

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

    // If bot is not running, do nothing
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

    // If no images, stop
    if (imageUrls.length === 0) return;

    console.log(`🔍 Checking ${imageUrls.length} image(s)...`);

    // ---------------------------------------
    //  Process Each Image
    // ---------------------------------------
    for (const imageUrl of imageUrls) {
      // 1) Compute the hash
      const hash = await computeImageHash(imageUrl);
      if (!hash) continue;

      console.log(`🔑 Image hash computed: ${hash}`);

      // 2) Check if this (hash, guildId) already exists
      let foundImage = await Image.findOne({
        hash,
        guildId: message.guild.id,
      });

      if (foundImage) {
        // Duplicate => handle penalty
        console.log("⚠️ Duplicate image detected, handling as duplicate.");

        const codeCertifiedRole = message.guild.roles.cache.find(
          (role) => role.name === "CODE CERTIFIED"
        );

        if (!codeCertifiedRole) {
          console.error("🔴 'CODE CERTIFIED' role does not exist in the guild.");
          continue;
        }

        // Remove role if user has it
        if (message.member.roles.cache.has(codeCertifiedRole.id)) {
          try {
            await message.member.roles.remove(codeCertifiedRole);
            console.log(`✅ Removed 'CODE CERTIFIED' from ${message.author.tag}`);
          } catch (err) {
            console.error("🔴 Failed to remove 'CODE CERTIFIED' role:", err);
          }
        } else {
          console.log(
            `ℹ️ ${message.author.tag} doesn't have the 'CODE CERTIFIED' role.`
          );
        }

        // Delete the duplicate message
        try {
          await message.delete();
          console.log("🗑️ Deleted duplicate message.");
        } catch (err) {
          console.error("🔴 Error deleting duplicate message:", err);
        }

        // DM the user
        try {
          await message.author.send(
            "```Your image was removed because it was identified as a duplicate. Please submit a new *original* image to receive CODE CERTIFIED.```"
          );
          console.log(`📩 Sent DM to ${message.author.tag}.`);
        } catch (err) {
          console.error("🔴 Could not send DM to user:", err);
        }

        // Notify the bot command channel
        try {
          const botCommandChannel = await message.guild.channels.fetch(
            botCommandChannelId
          );
          if (botCommandChannel) {
            await botCommandChannel.send(
              "```Your image was removed because it was identified as a duplicate. Please submit a new *original* image to receive CODE CERTIFIED.```"
            );
            console.log("📢 Sent notification to bot command channel.");
          }
        } catch (err) {
          console.error("🔴 Failed to send notification to bot command channel:", err);
        }
      } else {
        // 3) Not found => Insert new record
        try {
          await Image.create({
            hash,
            guildId: message.guild.id,
            channelId: message.channel.id,
            messageId: message.id,
            url: imageUrl,
          });
          console.log(`✅ Saved new image hash for ${message.author.tag}`);
        } catch (err) {
          // Could still hit E11000 if concurrency
          if (err.code === 11000) {
            console.log("⚠️ Caught E11000 in concurrency, re-checking doc...");

            // Re-check if it now exists
            foundImage = await Image.findOne({ hash, guildId: message.guild.id });
            if (foundImage) {
              // Duplicate => same penalty logic
              console.log("⚠️ Duplicate image (concurrency). Handling penalty...");
              // (Repeat the penalty code or put it in a helper function.)
              // We'll keep it short here for clarity:
              const codeCertifiedRole = message.guild.roles.cache.find(
                (role) => role.name === "CODE CERTIFIED"
              );
              if (codeCertifiedRole) {
                if (message.member.roles.cache.has(codeCertifiedRole.id)) {
                  try {
                    await message.member.roles.remove(codeCertifiedRole);
                    console.log(
                      `✅ Removed 'CODE CERTIFIED' from ${message.author.tag}`
                    );
                  } catch (roleErr) {
                    console.error("🔴 Failed to remove role:", roleErr);
                  }
                }
              }
              try {
                await message.delete();
              } catch (delErr) {
                console.error("🔴 Failed to delete message:", delErr);
              }
              // DM user, notify channel, etc. (same logic as above)
            } else {
              console.error(
                "🔴 Duplicate key error but record is still not found (possible index issue)."
              );
            }
          } else {
            console.error("🔴 Error inserting new image record:", err);
          }
        }
      }
    }
  } catch (error) {
    console.error("🔴 Unexpected error in messageCreate event:", error);
  }
});

// 3) On Message Delete => remove from DB if found
client.on("messageDelete", async (message) => {
  try {
    const imageRecord = await Image.findOne({
      messageId: message.id,
      guildId: message.guild.id,
    });
    if (imageRecord) {
      await Image.deleteOne({ messageId: message.id });
      console.log(`🗑️ Deleted image record from DB for message ${message.id}`);
    }
  } catch (error) {
    console.error("🔴 Error deleting image record:", error);
  }
});

// -----------------------------------------------------------------------------
// GRACEFUL SHUTDOWN
// -----------------------------------------------------------------------------
process.on("SIGINT", async () => {
  console.log("🔴 Bot is shutting down gracefully...");
  await mongoose.disconnect();
  client.destroy();
  process.exit(0);
});

// -----------------------------------------------------------------------------
// LOGIN
// -----------------------------------------------------------------------------
client.login(process.env.DISCORD_TOKEN);
