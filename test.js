import {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
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

// Mongoose schema for images
const imageSchema = new mongoose.Schema({
  hash: { type: String, unique: true },
  guildId: String,
  channelId: String,
  messageId: String,
  url: String,
});

const Image = mongoose.model("Image", imageSchema);

// Mongoose schema for guild configurations
const guildSchema = new mongoose.Schema({
  guildId: { type: String, unique: true },
  activeChannelId: String,
  botCommandChannelId: String,
});

const GuildConfig = mongoose.model("GuildConfig", guildSchema);

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

    message.attachments.forEach((attachment) => {
      if (
        attachment.contentType &&
        attachment.contentType.startsWith("image/") &&
        attachment.url
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

    console.log(`🔍 Checking ${imageUrls.length} image(s)...`);

    for (const imageUrl of imageUrls) {
      const hash = await computeImageHash(imageUrl);
      if (!hash) continue;

      console.log(`🔑 Image hash computed, Stored in the database`);

      const existingImage = await Image.findOne({
        hash,
        guildId: message.guild.id,
      });

      if (existingImage) {
        console.log("⚠️ Duplicate image detected, deleting message...");

        let emptyRole = message.guild.roles.cache.find(
          (role) => role.name === "Empty Role"
        );
        if (!emptyRole) {
          try {
            emptyRole = await message.guild.roles.create({
              name: "Empty Role",
              color: "DEFAULT",
              reason: "Role to penalize users for uploading duplicate images.",
            });
            console.log("✅ Created 'Empty Role' in the guild.");
          } catch (err) {
            console.error("🔴 Failed to create 'Empty Role':", err);
            return;
          }
        }

        try {
          await message.member.roles.add(emptyRole);
          console.log(
            `✅ Assigned 'Empty Role' to ${message.author.tag} for 24 hours.`
          );
        } catch (err) {
          console.error("🔴 Failed to assign 'Empty Role':", err);
        }

        setTimeout(async () => {
          try {
            await message.member.roles.remove(emptyRole);
            console.log(`✅ Removed 'Empty Role' from ${message.author.tag}.`);
          } catch (err) {
            console.error("🔴 Failed to remove 'Empty Role':", err);
          }
        }, 24 * 60 * 60 * 1000);

        try {
          await message.delete();

          const originalLink = `https://discord.com/channels/${existingImage.guildId}/${existingImage.channelId}/${existingImage.messageId}`;

          try {
            await message.author.send(
              `<@${message.author.id}> Your image was removed because it was identified as a duplicate.\nOriginal post: ${originalLink}`
            );
            console.log(
              `📩 Sent DM to ${message.author.tag} about duplicate image.`
            );
          } catch (err) {
            console.log("🔴 Could not send DM to user: ", err);
          }

          const botCommandChannel = await message.guild.channels.fetch(
            botCommandChannelId
          );
          if (botCommandChannel) {
            await botCommandChannel.send(
              `<@${message.author.id}> Your image was removed because it was identified as a duplicate.\nOriginal post: ${originalLink}`
            );
            console.log(`📢 Sent notification to bot command channel.`);
          }
        } catch (err) {
          console.log("🔴 Error deleting duplicate message:", err);
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
          console.log(`✅ Saved new image hash for ${message.author.tag}`);
        } catch (err) {
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

client.login(process.env.DISCORD_TOKEN);
