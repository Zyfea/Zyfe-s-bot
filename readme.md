```markdown
# Discord Duplicate Image Bot

A **Discord bot** that prevents users from posting the same image more than once. It uses **MongoDB** to store image hashes, and **Discord.js** to interface with Discord. When a duplicate image is detected, the bot assigns a temporary role to the user and deletes the message, ensuring a fair environment for giveaways or other activities.

---

## Table of Contents

- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [Commands](#commands)
- [Additional Notes](#additional-notes)

---

## Features

- **Duplicate Detection**: Compares image hashes to a database and detects duplicates across the same guild.  
- **Temporary Penalty Role**: Assigns a temporary role (“temp” by default) to the user who posted a duplicate.  
- **Automatic Message Deletion**: Deletes the duplicate message immediately.  
- **User Notification**: Sends a direct message and a public message (in a designated bot command channel) explaining that the duplicate was removed.  
- **24-Hour Role Removal**: Automatically removes the penalty role after 24 hours.  
- **Customizable Channels**: Allows you to configure which channel the bot listens to for images and which channel the bot sends notifications to.

---

## Prerequisites

1. **Node.js (v16 or higher)**  
   - [Download Node.js](https://nodejs.org)

2. **NPM** (comes with Node.js) or **Yarn** (optional)

3. **MongoDB Connection**  
   - You can use MongoDB Atlas ([Sign up here](https://www.mongodb.com/cloud/atlas)) or a local MongoDB instance.  
   - Make sure you have a valid connection string (URI).

4. **Discord Bot Token**  
   - Create a new application and bot on the [Discord Developer Portal](https://discord.com/developers/applications).  
   - Copy the **Bot Token** from the “Bot” section.

5. **Permissions**  
   - Your bot needs permissions to **manage roles**, **manage messages**, and **read/send messages** in your guild.

---

## Installation

1. **Clone this repository** or download the code:

   ```bash
   git clone https://github.com/yourusername/discord-duplicate-image-bot.git
   cd discord-duplicate-image-bot
   ```

2. **Install dependencies**:

   ```bash
   npm install
   ```
   This will install `discord.js`, `mongoose`, `dotenv`, `image-hash`, `node-fetch`, and other required packages.

3. **Create a `.env` file** in the root folder (same level as `package.json`) and add the following:

   ```bash
   MONGODB_URI=mongodb+srv://<username>:<password>@cluster0.mongodb.net/mydatabase?retryWrites=true&w=majority
   DISCORD_TOKEN=YOUR_DISCORD_BOT_TOKEN_HERE
   ```

   - Replace the placeholders with your actual **MongoDB** URI and **Discord Bot Token**.

---

## Configuration

By default, the bot has these environment variables:

- **`MONGODB_URI`**: Connection string to your MongoDB database.  
- **`DISCORD_TOKEN`**: Your Discord bot token.

All other settings, like the “temp” role name or the channels to use, are handled **in Discord** via commands (see [Commands](#commands)).

---

## Usage

1. **Start the Bot**:

   ```bash
   npm start
   ```
   If everything is set up correctly, you should see something like:
   ```
   ✅ Connected to MongoDB.
   ✅ Logged in as YourBotName#1234!
   ```
   This means your bot is online and listening.

2. **Invite the Bot to Your Server**  
   - In the [Discord Developer Portal](https://discord.com/developers/applications), go to **OAuth2 > URL Generator**.  
   - Select “bot” scope.  
   - Under **Bot Permissions**, select **Manage Roles**, **Manage Messages**, **View Channels**, **Send Messages**, etc.  
   - Copy the generated link and open it in your browser.  
   - Select the server you want to add the bot to, then click **Authorize**.  
   - Your bot should now appear in that server’s member list.

---

## Commands

### 1. **Setup Command**

```
!setup <activeChannelId> <botCommandChannelId>
```

- **activeChannelId**: ID of the channel where people will post images (the bot will monitor this channel).
- **botCommandChannelId**: ID of the channel where the bot will post notifications about duplicates and user penalties.

> **How to find Channel IDs?**  
> - Enable Developer Mode in Discord ([User Settings > Advanced > Developer Mode]).  
> - Right-click the channel and select **Copy ID**.

Example usage:
```
!setup 123456789012345678 987654321098765432
```
After running this command, the bot will save the channels to your server’s configuration in MongoDB.

### 2. **Start/Stop Bot**

```
!startbot
```
- Turns the bot’s duplicate-checking **on**.

```
!stopbot
```
- Turns the bot’s duplicate-checking **off**.  
- The bot will ignore images posted until you run `!startbot` again.

> **Note**: Both commands require **administrator** permissions to run.

---

## Additional Notes

1. **Duplicate Key Error But Not Found**  
   - If you see a log message like “Duplicate key error but existing image not found,” this might be due to a small timing or concurrency glitch.  
   - Usually, it means MongoDB believes a record is already in the database, but it can’t be found—possibly because it was inserted or deleted in a race condition.

2. **24-Hour Role Assignment**  
   - By default, the bot removes the penalty (“temp”) role after **24 hours** using a simple `setTimeout`. If the bot restarts during that time, the removal might not be scheduled again. You can build more robust scheduling with a database if needed.

3. **Local Testing**  
   - If you want to test the bot privately, create a small test server, invite the bot there, and configure the channel IDs with `!setup`.  
   - Then drag-and-drop images to confirm the bot logs them, detects duplicates, and issues penalties.

4. **Image Hashing**  
   - The [`image-hash`](https://www.npmjs.com/package/image-hash) library does a perceptual 16×16 hash by default. It’s fairly sensitive, so small changes to an image may not trigger a match. If you need strict matching, consider different hash settings or a direct byte comparison.
