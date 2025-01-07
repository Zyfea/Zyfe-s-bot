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

// 1) Image Schema
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

// 2) GuildConfig Schema
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
    GatewayIntentBits.DirectMessages,
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
// DISCORD: Client Event Handlers
// -----------------------------------------------------------------------------

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}!`);
});

client.on("messageCreate", async (message) => {
  try {
    // Ignore bot messages
    if (message.author.bot) return;

    // Check if configured
    const guildConfig = await GuildConfig.findOne({
      guildId: message.guild.id,
    });
    if (!guildConfig) return;

    const { activeChannelId, botCommandChannelId } = guildConfig;

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

      const [_, newActiveChannelId, newBotCommandChannelId] =
        message.content.split(" ");

      if (!newActiveChannelId || !newBotCommandChannelId) {
        await message.reply(
          "❌ Usage: `!setup <activeChannelId> <botCommandChannelId>`"
        );
        return;
      }

      await GuildConfig.findOneAndUpdate(
        { guildId: message.guild.id },
        {
          guildId: message.guild.id,
          activeChannelId: newActiveChannelId,
          botCommandChannelId: newBotCommandChannelId,
        },
        { upsert: true }
      );

      await message.reply("✅ Configuration saved successfully.");
      console.log(`✅ Setup completed for guild: ${message.guild.id}`);
      return;
    }

    // Only process images in the "active" channel
    if (message.channel.id !== activeChannelId) return;

    // ---------------------------------------
    //  Start and Stop Bot: "!startbot" / "!stopbot"
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

    // If the bot is stopped, ignore image processing
    if (!botRunning) return;

    // ---------------------------------------
    //  Collect Images (Attachments + Embeds)
    // ---------------------------------------
    let imageUrls = [];

    // Attachments
    message.attachments.forEach((attachment) => {
      if (
        attachment.contentType &&
        attachment.contentType.startsWith("image/") &&
        attachment.url
      ) {
        imageUrls.push(attachment.url);
      }
    });

    // Embeds
    message.embeds.forEach((embed) => {
      if (embed.image && embed.image.url) {
        imageUrls.push(embed.image.url);
      }
    });

    if (imageUrls.length === 0) return;
    console.log(`🔍 Checking ${imageUrls.length} image(s)...`);

    // ---------------------------------------
    //  Process Each Image
    // ---------------------------------------
    for (const imageUrl of imageUrls) {
      const hash = await computeImageHash(imageUrl);
      if (!hash) continue;

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

        // Check if newly inserted
        const wasInserted =
          existingImage.createdAt &&
          existingImage.createdAt.getTime() === existingImage.updatedAt.getTime();

        if (wasInserted) {
          // New image => no penalty
          console.log(`✅ Saved new image hash for ${message.author.tag}`);
        } else {
          // ---------------------------------------
          // Duplicate image => remove "CODE CERTIFIED"
          // ---------------------------------------
          console.log("⚠️ Duplicate image detected, handling as duplicate.");

          // 1) Remove the "CODE CERTIFIED" role if it exists
          const codeCertifiedRole = message.guild.roles.cache.find(
            (role) => role.name === "CODE CERTIFIED"
          );
          if (codeCertifiedRole) {
            try {
              await message.member.roles.remove(codeCertifiedRole);
              console.log(
                `✅ Removed "CODE CERTIFIED" from ${message.author.tag}.`
              );
            } catch (err) {
              console.error("🔴 Failed to remove CODE CERTIFIED role:", err);
            }
          }

          // 2) Delete the duplicate message
          try {
            await message.delete();
            console.log("🗑️ Deleted duplicate message.");
          } catch (err) {
            console.error("🔴 Error deleting duplicate message:", err);
          }

          // 3) Construct the link to the original image
          const originalLink = `https://discord.com/channels/${existingImage.guildId}/${existingImage.channelId}/${existingImage.messageId}`;

          // 4) Notify user via DM
          try {
            await message.author.send(
              `\`\`\`Your image was removed because it was identified as a duplicate. Your "CODE CERTIFIED" role has been removed. Please resubmit a brand-new image to regain CODE CERTIFIED status.\`\`\``
            );
            console.log(`📩 Sent DM to ${message.author.tag}.`);
          } catch (err) {
            console.log("🔴 Could not send DM to user:", err);
          }

          // 5) Notify the bot command channel
          try {
            const botCommandChannel = await message.guild.channels.fetch(
              botCommandChannelId
            );
            if (botCommandChannel) {
              await botCommandChannel.send(
                `\`\`\`Removed a duplicate image from ${message.author.tag}, and their "CODE CERTIFIED" role was removed.\`\`\``
              );
              console.log("📢 Sent notification to bot command channel.");
            }
          } catch (err) {
            console.error("🔴 Failed to send notification to bot command channel:", err);
          }
        }
      } catch (err) {
        // Handle E11000 (duplicate key) separately
        if (err.code === 11000) {
          console.log("⚠️ Duplicate key error detected, handling as duplicate.");

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
            if (codeCertifiedRole) {
              try {
                await message.member.roles.remove(codeCertifiedRole);
                console.log(
                  `✅ Removed "CODE CERTIFIED" from ${message.author.tag}.`
                );
              } catch (error) {
                console.error("🔴 Failed to remove CODE CERTIFIED role:", error);
              }
            }

            // Delete the message
            try {
              await message.delete();
              console.log("🗑️ Deleted duplicate message.");
            } catch (error) {
              console.error("🔴 Error deleting duplicate message:", error);
            }

            // Construct original link
            const originalLink = `https://discord.com/channels/${existingImage.guildId}/${existingImage.channelId}/${existingImage.messageId}`;

            // DM user
            try {
              await message.author.send(
                `\`\`\`Your image was removed because it was identified as a duplicate. Your "CODE CERTIFIED" role has been removed. Please resubmit a brand-new image to regain CODE CERTIFIED status.\`\`\``
              );
              console.log(`📩 Sent DM to ${message.author.tag}.`);
            } catch (error) {
              console.log("🔴 Could not send DM to user:", error);
            }

            // Notify bot command channel
            try {
              const botCommandChannel = await message.guild.channels.fetch(
                botCommandChannelId
              );
              if (botCommandChannel) {
                await botCommandChannel.send(
                  `\`\`\`Removed a duplicate image from ${message.author.tag}, and their "CODE CERTIFIED" role was removed.\`\`\``
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
            console.error("🔴 Duplicate key error but existing image not found.");
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

client.on("messageDelete", async (message) => {
  try {
    const imageRecord = await Image.findOne({
      messageId: message.id,
      guildId: message.guild.id,
    });
    if (imageRecord) {
      await Image.deleteOne({ messageId: message.id });
      console.log(`🗑️ Deleted image record from database for message ${message.id}`);
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
