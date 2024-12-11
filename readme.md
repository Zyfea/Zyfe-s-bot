# Discord Duplicate Image Moderation Bot

This project is a Discord bot designed to identify and remove duplicate images uploaded to your Discord server. It uses MongoDB for storing image hashes, allowing it to efficiently track duplicates. This bot also includes administrator commands to start and stop its functionality.

## Features

- Detects and removes duplicate images based on their SHA-256 hash.
- Notifies the user about the removed duplicate via a direct message (DM).
- Maintains a database of previously uploaded image hashes.
- Administrator commands to start (`!startbot`) and stop (`!stopbot`) the bot's operation.
- Automatically deletes database records when corresponding messages are removed.

## Prerequisites

1. **Node.js** (v16.9.0 or later)
2. **MongoDB**
3. A **Discord Bot Token**
4. A `.env` file to store sensitive information (see below for details).

## Installation

1. Clone this repository:
   ```bash
   git clone https://github.com/BJ-dev0706/Discord-bot
   cd Discord-bot
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file in the root directory and include the following:
   ```env
   DISCORD_TOKEN=your_discord_bot_token
   MONGODB_URI=your_mongodb_connection_string
   ```

4. Start the bot:
   ```bash
   node bot.js
   ```

## Usage

### Commands

- **!startbot**: Starts the bot's operation. Requires administrator permissions.
- **!stopbot**: Stops the bot's operation. Requires administrator permissions.

### Duplicate Image Detection

The bot will:
- Monitor all incoming messages in text channels.
- Check for attached images or embedded image links.
- Compute a SHA-256 hash for each image.
- Compare the hash against stored hashes in the MongoDB database.
- Delete the message if it contains a duplicate image and notify the user.

## File Structure

```
├── bot.js          # Main bot logic
├── package.json    # Project dependencies
├── .env            # Environment variables
```

## Dependencies

The project uses the following Node.js packages:

- [discord.js](https://discord.js.org/) for interacting with the Discord API.
- [mongoose](https://mongoosejs.com/) for MongoDB integration.
- [node-fetch](https://www.npmjs.com/package/node-fetch) for fetching image data.
- [crypto](https://nodejs.org/api/crypto.html) for hashing image data.
- [dotenv](https://www.npmjs.com/package/dotenv) for managing environment variables.

## Contributing

1. Fork the repository.
2. Create a feature branch (`git checkout -b feature-name`).
3. Commit your changes (`git commit -m 'Add feature'`).
4. Push to the branch (`git push origin feature-name`).
5. Open a pull request.

## License

This project is licensed under the MIT License. See the `LICENSE` file for more information.

## Troubleshooting

### Common Issues

1. **MongoDB Connection Fails**:
   - Ensure MongoDB is running and the connection string in the `.env` file is correct.

2. **Bot Fails to Log In**:
   - Verify the Discord token in the `.env` file.

3. **Bot Does Not Delete Duplicates**:
   - Check the bot's permissions in the Discord server.
   - Ensure the bot has access to the required channels.

## Contact

For issues or feature requests, feel free to open an issue or contribute to the project.
