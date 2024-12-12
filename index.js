import {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
} from "discord.js";
import mongoose from "mongoose";
import fetch from "node-fetch";
import crypto from "crypto";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { imageHash } from "image-hash";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const imageSchema = new mongoose.Schema({
  hash: { type: String, unique: true },
  guildId: String,
  channelId: String,
  messageId: String,
  url: String,
});

const Image = mongoose.model("Image", imageSchema);

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
const botCommandChannelId = process.env.COMMAND_CHANNEL_ID;
const activeChannelId = process.env.ACTIVE_CHANNEL_ID;

mongoose
  .connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => {
    console.log("✅ Connected to MongoDB.");
  })
  .catch((err) => {
    console.error("❌ Failed to connect to MongoDB:", err);
    process.exit(1);
  });

/**
 * Computes the SHA-256 hash of an image from its URL.
 * @param {string} url - The URL of the image.
 * @returns {string|null} - The hexadecimal hash string or null if failed.
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

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}!`);
});

/**
 * Event: Message Created
 * Triggered whenever a new message is created in a guild the bot has access to.
 */
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;

    // Check if the message is in the specified active channel
    if (message.channel.id !== activeChannelId) return;

    if (
      message.content.startsWith("!startbot") ||
      message.content.startsWith("!stopbot")
    ) {
      // Bot control commands
      if (message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        if (message.content.startsWith("!startbot")) {
          botRunning = true;
          await message.reply("✅ The bot is now running.");
          console.log("✅ Bot started by an administrator.");
        } else if (message.content.startsWith("!stopbot")) {
          botRunning = false;
          await message.reply("🛑 The bot has been stopped.");
          console.log("🛑 Bot stopped by an administrator.");
        }
      } else {
        await message.reply("❌ You do not have permission to run this command.");
      }
      return;
    }

    if (!botRunning) return;

    let imageUrls = [];

    message.attachments.forEach((attachment) => {
      if (
        attachment.contentType &&
        attachment.contentType.startsWith("image/")
      ) {
        imageUrls.push(attachment.url);
      }
    });

    message.embeds.forEach((embed) => {
      if (embed.image && embed.image.url) {
        imageUrls.push(embed.image.url);
      }
    });

    if (imageUrls.length === 0) return;

    for (const imageUrl of imageUrls) {
      const hash = await computeImageHash(imageUrl);
      if (!hash) {
        try {
          // If image cannot be hashed, delete the message and notify the user
          await message.delete();

          await message.author.send(
            `<@${message.author.id}> Sorry Please upload different types of images`
          );
          console.log(`📩 Sent DM to ${message.author.tag} about non-hashable image.`);

          // Optionally notify the bot command channel about the deleted image
          const botCommandChannel = await message.guild.channels.fetch(botCommandChannelId);
          if (botCommandChannel) {
            await botCommandChannel.send(
              `<@${message.author.id}> Sorry, Please upload different types of images`
            );
            console.log(`📢 Sent notification to bot command channel about non-hashable image.`);
          }

          console.log(`🗑️ Deleted non-hashable image from ${message.author.tag}`);
        } catch (err) {
          console.error("🔴 Error deleting message for non-hashable image:", err);
        }
        continue;
      }

      // Existing logic for handling hashable images
      const existingImage = await Image.findOne({ hash });

      if (existingImage) {
        try {
          await message.delete();

          const originalLink = `https://discord.com/channels/${existingImage.guildId}/${existingImage.channelId}/${existingImage.messageId}`;

          try {
            await message.author.send(
              `<@${message.author.id}> Your image was removed because it was identified as a duplicate.${originalLink}`
            );
            console.log(
              `📩 Sent DM to ${message.author.tag} about duplicate image.`
            );
          } catch (err) {
            console.error(
              `🔴 Could not send DM to ${message.author.tag}:`,
              err
            );
          }

          // Notify in the bot command channel about the deleted duplicate image
          const botCommandChannel = await message.guild.channels.fetch(
            botCommandChannelId
          );
          if (botCommandChannel) {
            await botCommandChannel.send(
              `<@${message.author.id}> Your image was removed because it was identified as a duplicate.${originalLink}`
            );
            console.log(
              `📢 Sent notification to bot command channel about duplicate image deletion.`
            );
          }


          console.log(`🗑️ Deleted duplicate image from ${message.author.tag}`);
        } catch (err) {
          if (err.code === 10008) {
            console.warn("⚠️ Tried to delete a message that does not exist.");
          } else {
            console.error("🔴 Error deleting message:", err);
          }
        }
      } else {
        const newImage = new Image({
          hash,
          guildId: message.guild.id,
          channelId: message.channel.id,
          messageId: message.id,
          url: imageUrl,
        });

        try {
          await newImage.save();
          console.log(`🆕 Saved new image hash from ${message.author.tag}`);
        } catch (err) {
          if (err.code === 11000) {
            try {
              await message.delete();

              const existing = await Image.findOne({ hash });

              const originalLink = existing
                ? `https://discord.com/channels/${existing.guildId}/${existing.channelId}/${existing.messageId}`
                : "Unknown";

              await message.author.send(
                `<@${message.author.id}> Your image was removed because it was identified as a duplicate.${originalLink}`
              );

              console.log(
                `📩 Sent DM to ${message.author.tag} about duplicate image.`
              );
              console.log(
                `🗑️ Deleted duplicate image from ${message.author.tag}`
              );
            } catch (error) {
              if (error.code === 10008) {
                console.warn(
                  "⚠️ Tried to delete a message that does not exist."
                );
              } else {
                console.error("🔴 Error handling duplicate message:", error);
              }
            }
          } else {
            console.error("🔴 Error saving image hash:", err);
          }
        }
      }
    }
  } catch (error) {
    console.error("🔴 Unexpected error in messageCreate event:", error);
  }
});


/**
 * Event: Message Deleted
 * Triggered whenever a message is deleted in a guild the bot has access to.
 */
client.on("messageDelete", async (message) => {
  try {
    if (!botRunning) return;

    const imageRecord = await Image.findOne({ messageId: message.id });
    if (!imageRecord) return;

    await Image.deleteOne({ messageId: message.id });
    console.log(
      `🗑️ Removed image hash from database as original message was deleted.`
    );
  } catch (error) {
    if (error.code === 10008) {
      console.warn("⚠️ Tried to delete a message that does not exist.");
    } else {
      console.error("🔴 Unexpected error in messageDelete event:", error);
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
