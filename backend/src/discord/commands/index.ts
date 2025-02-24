import { Client, REST, Routes, SlashCommandBuilder, Collection } from 'discord.js';
import { play } from './play';
import { skip } from './skip';
import { queue } from './queue';
import { search } from './search';
import { data as playlistData, execute as playlistExecute } from './playlist';
import { data as adminData, execute as adminExecute } from './admin';

export const commands = new Collection();
commands.set('play', play);
commands.set('skip', skip);
commands.set('queue', queue);
commands.set('search', search);
commands.set('playlist', playlistExecute);
commands.set('admin', adminExecute);

const commandData = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song from YouTube')
    .addStringOption(option =>
      option
        .setName('query')
        .setDescription('YouTube URL or search query')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skip the current song'),

  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show the current queue'),

  new SlashCommandBuilder()
    .setName('search')
    .setDescription('Search for a song on YouTube')
    .addStringOption(option =>
      option
        .setName('query')
        .setDescription('Search query')
        .setRequired(true)
    ),

  playlistData,
  adminData
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
    for (const [name, handler] of commands) {
      client.commands.set(name, handler);
    }

    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error('Error registering commands:', error);
  }
} 