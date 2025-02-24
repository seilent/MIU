import { Client } from 'discord.js';
import { setupDiscordBot } from './index';

let client: Client | null = null;

export async function initializeDiscordClient() {
  if (!client) {
    client = await setupDiscordBot();
  }
  return client;
}

export function getDiscordClient() {
  return client;
} 