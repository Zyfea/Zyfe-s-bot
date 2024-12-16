import {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  Events,
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

const TEMP_ROLE_NAME = "Duplicate Image Warning"; // Name of the temporary role
const TEMP_ROLE_DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
const DB_RETRY_INTERVAL = 5000; // 5 seconds
const IMAGE_HASH_BITS = 16; // Bits for image hashing


const imageSchema = new mongoose.Schema({
  hash: { type: String, unique: true, required: true },
  guildId: { type: String, required: true },
  channelId: { type: String, required: true },
  messageId: { type: String, required: true },
  url: { type: String, required: true },
});

const Image = mongoose.model("Image", imageSchema);

const guildSchema = new mongoose.Schema({
  guildId: { type: String, unique: true, required: true },
  activeChannelId: { type: String, required: true },
  botCommandChannelId: { type: String, required: true },
});

const GuildConfig = mongoose.model("GuildConfig", guildSchema);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, // For guild-related events
    GatewayIntentBits.GuildMessages, // For message-related events
    GatewayIntentBits.MessageContent, // To read message content
    GatewayIntentBits.DirectMessages, // For direct messages
  ],
  partials: [Partials.Message, Partials.Channel], // For partials
});

let botRunning = true;

const connectToDatabase = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("✅ Connected to MongoDB.");
  } catch (err) {
    console.error("❌ Failed to connect to MongoDB:", err);
    console.log(`🔄 Retrying MongoDB connection in ${DB_RETRY_INTERVAL / 1000} seconds...`);
    setTimeout(connectToDatabase, DB_RETRY_INTERVAL);
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

    return new Promise((resolve) => {
      imageHash(imageUrl, IMAGE_HASH_BITS, true, (error, data) => {
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

/**
 * Creates the temporary role if it doesn't exist.
 * @param {Guild} guild - The Discord guild.
 * @returns {Promise<Role|null>} - The created or existing role, or null on failure.
 */
const createTempRole = async (guild) => {
  try {
    let role = guild.roles.cache.find((r) => r.name === TEMP_ROLE_NAME);
    if (role) {
      return role;
    }

    role = await guild.roles.create({
      name: TEMP_ROLE_NAME,
      color: "Red",
      permissions: [],
      reason: "Temporary role for duplicate image uploads",
    });

    console.log(`✅ Created temporary role "${TEMP_ROLE_NAME}" in guild "${guild.name}".`);
    return role;
  } catch (error) {
    console.error(`🔴 Error creating temporary role in guild "${guild.name}":`, error);
    return null;
  }
};

/**
 * Assigns a temporary role to a user for a specified duration.
 * @param {Guild} guild - The Discord guild.
 * @param {GuildMember} member - The guild member to assign the role to.
 */
const assignTempRole = async (guild, member) => {
  try {
    const role = await createTempRole(guild);
    if (!role) return;

    await member.roles.add(role);
    console.log(`✅ Assigned temporary role to ${member.user.tag} in guild "${guild.name}".`);

    setTimeout(async () => {
      try {
        await member.roles.remove(role);
        console.log(`✅ Removed temporary role from ${member.user.tag} in guild "${guild.name}".`);
      } catch (err) {
        console.error(`🔴 Error removing temporary role from ${member.user.tag}:`, err);
      }
    }, TEMP_ROLE_DURATION);
  } catch (error) {
    console.error(`🔴 Error assigning temporary role to ${member.user.tag}:`, error);
  }
};

client.once(Events.ClientReady, () => {
  console.log(`✅ Logged in as ${client.user.tag}!`);
});

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;

    if (!message.guild) return;

    const guildConfig = await GuildConfig.findOne({ guildId: message.guild.id }).exec();

    if (message.content.startsWith("!setup")) {
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        await message.reply("❌ Only administrators can run this command.");
        return;
      }

      const args = message.content.trim().split(/\s+/);
      if (args.length !== 3) {
        await message.reply("❌ Usage: `!setup <activeChannelId> <botCommandChannelId>`");
        return;
      }

      const [_, activeChannelId, botCommandChannelId] = args;

      const activeChannel = message.guild.channels.cache.get(activeChannelId);
      const botCommandChannel = message.guild.channels.cache.get(botCommandChannelId);

      if (!activeChannel || !botCommandChannel) {
        await message.reply("❌ One or both channel IDs are invalid.");
        return;
      }

      await GuildConfig.findOneAndUpdate(
        { guildId: message.guild.id },
        {
          guildId: message.guild.id,
          activeChannelId,
          botCommandChannelId,
        },
        { upsert: true, new: true }
      );

      await message.reply("✅ Configuration saved successfully.");
      console.log(`✅ Setup completed for guild: ${message.guild.id}`);
      return;
    }

    if (message.content.startsWith("!startbot") || message.content.startsWith("!stopbot")) {
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
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

    if (!botRunning) return;

    if (!guildConfig) return;

    const { activeChannelId, botCommandChannelId } = guildConfig;

    if (message.channel.id !== activeChannelId) return;

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

    console.log(`🔍 Checking ${imageUrls.length} image(s) in message ${message.id} from user ${message.author.tag}.`);

    for (const imageUrl of imageUrls) {
      const hash = await computeImageHash(imageUrl);
      if (!hash) continue;

      const existingImage = await Image.findOne({ hash, guildId: message.guild.id }).exec();

      if (existingImage) {
        console.log(`⚠️ Duplicate image detected in guild "${message.guild.id}".`);

        try {
          await message.delete();
          console.log(`🗑️ Deleted duplicate message ${message.id} from user ${message.author.tag}.`);
        } catch (err) {
          console.error(`🔴 Error deleting message ${message.id}:`, err);
        }

        const originalLink = `https://discord.com/channels/${existingImage.guildId}/${existingImage.channelId}/${existingImage.messageId}`;

        try {
          await message.author.send(
            `⚠️ You have uploaded a duplicate image. Your image was removed.\nOriginal image: ${originalLink}`
          );
          console.log(`📩 Sent DM to ${message.author.tag} about duplicate image.`);
        } catch (err) {
          console.error(`🔴 Could not send DM to ${message.author.tag}:`, err);
        }

        try {
          const botCommandChannel = await message.guild.channels.fetch(botCommandChannelId);
          if (botCommandChannel && botCommandChannel.isTextBased()) {
            await botCommandChannel.send(
              `⚠️ <@${message.author.id}> uploaded a duplicate image. The image was removed.\nOriginal image: ${originalLink}`
            );
            console.log(`📢 Sent notification to bot command channel in guild "${message.guild.id}".`);
          }
        } catch (err) {
          console.error(`🔴 Error sending notification to bot command channel:`, err);
        }

        const member = await message.guild.members.fetch(message.author.id).catch(() => null);
        if (member) {
          await assignTempRole(message.guild, member);
        } else {
          console.error(`🔴 Could not fetch member ${message.author.tag} to assign temporary role.`);
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
          console.log(`✅ Saved new image hash for ${message.author.tag} in guild "${message.guild.id}".`);
        } catch (err) {
          if (err.code === 11000) {
            console.warn(`⚠️ Duplicate hash detected while saving for message ${message.id}.`);
          } else {
            console.error(`🔴 Error saving image hash for message ${message.id}:`, err);
          }
        }
      }
    }
  } catch (error) {
    console.error("🔴 Unexpected error in messageCreate event:", error);
  }
});

client.on(Events.MessageDelete, async (message) => {
  try {
    if (!message.guild) return;

    const imageRecord = await Image.findOne({ messageId: message.id, guildId: message.guild.id }).exec();

    if (imageRecord) {
      await Image.deleteOne({ messageId: message.id, guildId: message.guild.id }).exec();
      console.log(`🗑️ Deleted image record for message ${message.id} from database.`);
    }
  } catch (error) {
    console.error("🔴 Error in messageDelete event:", error);
  }
});

const gracefulShutdown = async () => {
  console.log("🔴 Bot is shutting down gracefully...");

  try {
    await mongoose.disconnect();
    console.log("✅ Disconnected from MongoDB.");
  } catch (err) {
    console.error("🔴 Error disconnecting from MongoDB:", err);
  }

  try {
    await client.destroy();
    console.log("✅ Discord client destroyed.");
  } catch (err) {
    console.error("🔴 Error destroying Discord client:", err);
  }

  process.exit(0);
};

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error("🔴 Failed to login to Discord:", err);
  process.exit(1);
});
