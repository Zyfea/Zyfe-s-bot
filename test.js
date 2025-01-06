// Import necessary modules and dependencies
import {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  Colors
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
//    - Holds a unique hash and references the message/guild info for that image.
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

// Create a compound unique index on hash and guildId
imageSchema.index({ hash: 1, guildId: 1 }, { unique: true });

// Image Model
const Image = mongoose.model("Image", imageSchema);

// 2) GuildConfig Schema:
//    - Holds configuration data for each guild (which channel is active, etc.)
const guildSchema = new mongoose.Schema({
  guildId: { type: String, unique: true },
  activeChannelId: String,
  botCommandChannelId: String,
});

// GuildConfig Model
const GuildConfig = mongoose.model("GuildConfig", guildSchema);

// -----------------------------------------------------------------------------
// DISCORD CLIENT SETUP
// -----------------------------------------------------------------------------

// Initialize Discord client with necessary intents and partials
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
// MONGODB CONNECTION
// -----------------------------------------------------------------------------

// Improved MongoDB connection with retries
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

    // image-hash requires a *file path* or a *file buffer*, but
    // it can also sometimes use a remote URL (depending on the version).
    // If you run into issues, you might need to save the image to disk
    // or convert to a buffer first. For simplicity, we’re passing the URL directly.
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

    // Check if the bot has been set up for this guild
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
        await message.reply("❌ You do not have permission to run this command.");
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
        // setOnInsert only sets these fields on the *insert* portion of upsert
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
        // A quick trick: newly inserted docs have matching createdAt == updatedAt
        const wasInserted =
          existingImage.createdAt &&
          existingImage.createdAt.getTime() === existingImage.updatedAt.getTime();

        if (wasInserted) {
          // New image
          console.log(`✅ Saved new image hash for ${message.author.tag}`);
        } else {
          // Duplicate image => handle penalty
          console.log("⚠️ Duplicate image detected, handling as duplicate.");

          // 1) Find or create the 'temp' role
          let tempRole = message.guild.roles.cache.find(
            (role) => role.name === "temp"
          );
          if (!tempRole) {
            try {
              tempRole = await message.guild.roles.create({
                name: "temp",
                color: Colors.Blue,
                reason: "Role to penalize users for uploading duplicate images.",
              });
              console.log("✅ Created 'temp' role in the guild.");
            } catch (err) {
              console.error("🔴 Failed to create 'temp' role:", err);
              continue; // skip duplicate handling if role creation fails
            }
          }

          // 2) Assign 'temp' role to user
          try {
            await message.member.roles.add(tempRole);
            console.log(
              `✅ Assigned 'temp' role to ${message.author.tag} for 24 hours.`
            );
          } catch (err) {
            console.error("🔴 Failed to assign 'temp' role:", err);
          }

          // 3) Schedule removal of 'temp' role after 24 hours
          setTimeout(async () => {
            try {
              await message.member.roles.remove(tempRole);
              console.log(`✅ Removed 'temp' role from ${message.author.tag}.`);
            } catch (err) {
              console.error("🔴 Failed to remove 'temp' role:", err);
            }
          }, 24 * 60 * 60 * 1000); // 24 hours

          // 4) Delete the duplicate message
          try {
            await message.delete();
            console.log("🗑️ Deleted duplicate message.");
          } catch (err) {
            console.error("🔴 Error deleting duplicate message:", err);
          }

          // 5) Construct the link to the *original* image
          const originalLink = `https://discord.com/channels/${existingImage.guildId}/${existingImage.channelId}/${existingImage.messageId}`;

          // 6) Notify user via DM
          try {
            await message.author.send(
              `<@${message.author.id}> Your image was removed because it was identified as a duplicate. ` +
                `You have been assigned the 'temp' role and will not be able to enter the giveaway for 24 hours.\n` +
                `Original post: ${originalLink}`
            );
            console.log(
              `📩 Sent DM to ${message.author.tag} about duplicate image.`
            );
          } catch (err) {
            console.log("🔴 Could not send DM to user:", err);
          }

          // 7) Notify the bot command channel
          try {
            const botCommandChannel = await message.guild.channels.fetch(
              botCommandChannelId
            );
            if (botCommandChannel) {
              await botCommandChannel.send(
                `<@${message.author.id}> Your image was removed because it was identified as a duplicate. ` +
                  `You have been assigned the 'temp' role and will not be able to enter the giveaway for 24 hours.\n` +
                  `Original post: ${originalLink}`
              );
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
          console.log("⚠️ Duplicate key error detected, handling as duplicate.");

          // Check if we can fetch the existing record
          const existingImage = await Image.findOne({
            hash: hash,
            guildId: message.guild.id,
          });

          if (existingImage) {
            // Same penalty logic
            let tempRole = message.guild.roles.cache.find(
              (role) => role.name === "temp"
            );
            if (!tempRole) {
              try {
                tempRole = await message.guild.roles.create({
                  name: "temp",
                  color: "#000",
                  reason:
                    "Role to penalize users for uploading duplicate images.",
                });
                console.log("✅ Created 'temp' role in the guild.");
              } catch (error) {
                console.error("🔴 Failed to create 'temp' role:", error);
                continue;
              }
            }

            // Assign 'temp' role
            try {
              await message.member.roles.add(tempRole);
              console.log(
                `✅ Assigned 'temp' role to ${message.author.tag} for 24 hours.`
              );
            } catch (error) {
              console.error("🔴 Failed to assign 'temp' role:", error);
            }

            // Schedule role removal after 24 hours
            setTimeout(async () => {
              try {
                await message.member.roles.remove(tempRole);
                console.log(
                  `✅ Removed 'temp' role from ${message.author.tag}.`
                );
              } catch (error) {
                console.error("🔴 Failed to remove 'temp' role:", error);
              }
            }, 24 * 60 * 60 * 1000);

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
                `<@${message.author.id}> Your image was removed because it was identified as a duplicate. ` +
                  `You cannot post images for 24 hours.\n` +
                  `Original post: ${originalLink}`
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
                  `<@${message.author.id}> Your image was removed because it was identified as a duplicate. ` +
                    `You cannot post images for 24 hours.\n` +
                    `Original post: ${originalLink}`
                );
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
            console.error("🔴 Duplicate key error but existing image not found.");
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

// 3) On Message Delete:
//    Remove the associated record from the database if found.
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