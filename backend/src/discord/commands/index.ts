import { Client, REST, Routes, SlashCommandBuilder, Collection } from 'discord.js';
import { play } from './play';
import { skip } from './skip';
import { queue } from './queue';
import { search } from './search';
import { ban } from './ban';
import { data as playlistData, execute as playlistExecute } from './playlist';
import { data as adminData, execute as adminExecute } from './admin';

export const commands = new Collection();
commands.set('play', play);
commands.set('skip', skip);
commands.set('queue', queue);
commands.set('search', search);
commands.set('ban', ban);
commands.set('playlist', playlistExecute);
commands.set('admin', adminExecute);

// Create the command builders
const playCommand = new SlashCommandBuilder()
  .setName('play')
  .setDescription('Play a song from YouTube')
  .addStringOption(option =>
    option
      .setName('query')
      .setDescription('YouTube URL or search query')
      .setRequired(true)
  );

const skipCommand = new SlashCommandBuilder()
  .setName('skip')
  .setDescription('Skip the current song');

const queueCommand = new SlashCommandBuilder()
  .setName('queue')
  .setDescription('Show the current queue');

const searchCommand = new SlashCommandBuilder()
  .setName('search')
  .setDescription('Search for a song on YouTube')
  .addStringOption(option =>
    option
      .setName('query')
      .setDescription('Search query')
      .setRequired(true)
  );

const banCommand = new SlashCommandBuilder()
  .setName('ban')
  .setDescription('Ban a song (admin only)')
  .addIntegerOption(option =>
    option
      .setName('position')
      .setDescription('Position in queue (starting from 1, leave empty to ban currently playing song)')
      .setRequired(false)
  );

// Convert all commands to JSON for REST API
const commandData = [
  playCommand.toJSON(),
  skipCommand.toJSON(),
  queueCommand.toJSON(),
  searchCommand.toJSON(),
  banCommand.toJSON(),
  playlistData.toJSON(),
  adminData.toJSON()
];

export async function registerCommands(client: Client) {
  try {
    console.log('Started refreshing application (/) commands.');

    const rest = new REST().setToken(process.env.DISCORD_TOKEN!);

    await rest.put(
      Routes.applicationCommands(process.env.DISCORD_CLIENT_ID!),
      { body: commandData }
    );

    // Register command handlers
    client.commands = new Collection();
    client.commands.set('play', play);
    client.commands.set('skip', skip);
    client.commands.set('queue', queue);
    client.commands.set('search', search);
    client.commands.set('ban', ban);
    client.commands.set('playlist', playlistExecute);
    client.commands.set('admin', adminExecute);

    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error('Error registering commands:', error);
  }
} 