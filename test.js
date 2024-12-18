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

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Mongoose schema for images with compound unique index and timestamps
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

const Image = mongoose.model("Image", imageSchema);

// Mongoose schema for guild configurations
const guildSchema = new mongoose.Schema({
  guildId: { type: String, unique: true },
  activeChannelId: String,
  botCommandChannelId: String,
});

const GuildConfig = mongoose.model("GuildConfig", guildSchema);

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

let botRunning = true;

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

/**
 * Computes the hash of an image from its URL.
 * @param {string} url - The URL of the image.
 * @returns {Promise<string|null>} - The hash string or null on error.
 */
const computeImageHash = async (url) => {
  try {
    const response = await fetch(url);
    if (!response.ok)
      throw new Error(`Failed to fetch image: ${response.statusText}`);
    const imageUrl = response.url;
    return new Promise((resolve, reject) => {
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

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}!`);
});

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;

    // Check if the bot has been set up for this guild
    const guildConfig = await GuildConfig.findOne({
      guildId: message.guild.id,
    });

    // Setup command
    if (message.content.startsWith("!setup")) {
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

      await GuildConfig.findOneAndUpdate(
        { guildId: message.guild.id },
        { guildId: message.guild.id, activeChannelId, botCommandChannelId },
        { upsert: true }
      );

      await message.reply("✅ Configuration saved successfully.");
      console.log(`✅ Setup completed for guild: ${message.guild.id}`);
      return;
    }

    // If not configured, ignore messages
    if (!guildConfig) return;

    const { activeChannelId, botCommandChannelId } = guildConfig;

    // Ignore messages outside the active channel
    if (message.channel.id !== activeChannelId) return;

    // Start and stop bot commands
    if (
      message.content.startsWith("!startbot") ||
      message.content.startsWith("!stopbot")
    ) {
      if (
        !message.member.permissions.has(PermissionsBitField.Flags.Administrator)
      ) {
        await message.reply(
          "❌ You do not have permission to run this command."
        );
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

    if (!botRunning) return;

    let imageUrls = [];

    // Collect image URLs from attachments
    message.attachments.forEach((attachment) => {
      if (
        attachment.contentType &&
        attachment.contentType.startsWith("image/") &&
        attachment.url
      ) {
        imageUrls.push(attachment.url);
      }
    });

    // Collect image URLs from embeds
    message.embeds.forEach((embed) => {
      if (embed.image && embed.image.url) {
        imageUrls.push(embed.image.url);
      }
    });

    if (imageUrls.length === 0) return;

    console.log(`🔍 Checking ${imageUrls.length} image(s)...`);

    for (const imageUrl of imageUrls) {
      const hash = await computeImageHash(imageUrl);
      if (!hash) continue;

      console.log(`🔑 Image hash computed: ${hash}`);

      try {
        // Attempt to insert the new image hash atomically
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

        // Check if the image was newly inserted
        const wasInserted = existingImage.createdAt && existingImage.createdAt.getTime() === existingImage.updatedAt.getTime();

        if (wasInserted) {
          console.log(`✅ Saved new image hash for ${message.author.tag}`);
        } else {
          // Image already exists, handle as duplicate
          console.log("⚠️ Duplicate image detected, handling as duplicate.");

          // Find or create the 'temp' role
          let tempRole = message.guild.roles.cache.find(
            (role) => role.name === "temp"
          );
          if (!tempRole) {
            try {
              tempRole = await message.guild.roles.create({
                name: "temp",
                color: Colors.Blue,
                reason:
                  "Role to penalize users for uploading duplicate images.",
              });
              console.log("✅ Created 'temp' role in the guild.");
            } catch (err) {
              console.error("🔴 Failed to create 'temp' role:", err);
              continue; // Skip duplicate handling if role creation fails
            }
          }

          // Assign the 'temp' role to the user
          try {
            await message.member.roles.add(tempRole);
            console.log(
              `✅ Assigned 'temp' role to ${message.author.tag} for 24 hours.`
            );
          } catch (err) {
            console.error("🔴 Failed to assign 'temp' role:", err);
          }

          // Schedule removal of the 'temp' role after 24 hours
          setTimeout(async () => {
            try {
              await message.member.roles.remove(tempRole);
              console.log(`✅ Removed 'temp' role from ${message.author.tag}.`);
            } catch (err) {
              console.error("🔴 Failed to remove 'temp' role:", err);
            }
          }, 24 * 60 * 60 * 1000); // 24 hours in milliseconds

          // Delete the duplicate message
          try {
            await message.delete();
            console.log("🗑️ Deleted duplicate message.");
          } catch (err) {
            console.error("🔴 Error deleting duplicate message:", err);
          }

          // Construct the link to the original image
          const originalLink = `https://discord.com/channels/${existingImage.guildId}/${existingImage.channelId}/${existingImage.messageId}`;

          // Notify the user via DM
          try {
            await message.author.send(
              `<@${message.author.id}> Your image was removed because it was identified as a duplicate. You will be assigned the "Duplicate Image" role and will not be able to enter the giveaway for 24 hours. \nOriginal post: ${originalLink}`
            );
            console.log(
              `📩 Sent DM to ${message.author.tag} about duplicate image.`
            );
          } catch (err) {
            console.log("🔴 Could not send DM to user:", err);
          }

          // Notify the bot command channel
          try {
            const botCommandChannel = await message.guild.channels.fetch(
              botCommandChannelId
            );
            if (botCommandChannel) {
              await botCommandChannel.send(
                `<@${message.author.id}> Your image was removed because it was identified as a duplicate. You will be assigned the "Duplicate Image" role and will not be able to enter the giveaway for 24 hours. \nOriginal post: ${originalLink}`
              );
              console.log(`📢 Sent notification to bot command channel.`);
            }
          } catch (err) {
            console.error("🔴 Failed to send notification to bot command channel:", err);
          }
        }
      } catch (err) {
        if (err.code === 11000) {
          // Duplicate key error, handle as duplicate
          console.log("⚠️ Duplicate key error detected, handling as duplicate.");

          // Fetch the existing image to get details for original link
          const existingImage = await Image.findOne({
            hash: hash,
            guildId: message.guild.id,
          });

          if (existingImage) {
            // Handle duplicate image as per existing logic

            // Find or create the 'temp' role
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
                continue; // Skip duplicate handling if role creation fails
              }
            }

            // Assign the 'temp' role to the user
            try {
              await message.member.roles.add(tempRole);
              console.log(
                `✅ Assigned 'temp' role to ${message.author.tag} for 24 hours.`
              );
            } catch (error) {
              console.error("🔴 Failed to assign 'temp' role:", error);
            }

            // Schedule removal of the 'temp' role after 24 hours
            setTimeout(async () => {
              try {
                await message.member.roles.remove(tempRole);
                console.log(`✅ Removed 'temp' role from ${message.author.tag}.`);
              } catch (error) {
                console.error("🔴 Failed to remove 'temp' role:", error);
              }
            }, 24 * 60 * 60 * 1000); // 24 hours in milliseconds

            // Delete the duplicate message
            try {
              await message.delete();
              console.log("🗑️ Deleted duplicate message.");
            } catch (error) {
              console.error("🔴 Error deleting duplicate message:", error);
            }

            // Construct the link to the original image
            const originalLink = `https://discord.com/channels/${existingImage.guildId}/${existingImage.channelId}/${existingImage.messageId}`;

            // Notify the user via DM
            try {
              await message.author.send(
                `<@${message.author.id}> Your image was removed because it was identified as a duplicate. You cannot post images for 24 hours.\nOriginal post: ${originalLink}`
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
                  `<@${message.author.id}> Your image was removed because it was identified as a duplicate. You cannot post images for 24 hours.\nOriginal post: ${originalLink}`
                );
                console.log(`📢 Sent notification to bot command channel.`);
              }
            } catch (error) {
              console.error("🔴 Failed to send notification to bot command channel:", error);
            }
          } else {
            console.error(
              "🔴 Duplicate key error but existing image not found."
            );
          }
        } else {
          console.error("🔴 Error saving new image hash:", err);
        }
      }
    }
  } catch (error) {
    console.error("🔴 Unexpected error in messageCreate event:", error);
  }
});

// Delete image from database when message is deleted
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

// Graceful shutdown on process termination
process.on("SIGINT", async () => {
  console.log("🔴 Bot is shutting down gracefully...");
  await mongoose.disconnect();
  client.destroy();
  process.exit(0);
});

// Log in to Discord with your bot token
client.login(process.env.DISCORD_TOKEN);
