/// <reference types="jest" />
import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';

// Load environment variables
config();

// Mock Redis
jest.mock('ioredis', () => {
  const RedisMock = require('@jest-mock/ioredis');
  return RedisMock;
});

// Mock Prisma
jest.mock('@prisma/client', () => {
  const { PrismaClient } = jest.requireActual('@prisma/client');
  return {
    PrismaClient: jest.fn().mockImplementation(() => ({
      $connect: jest.fn(),
      $disconnect: jest.fn(),
      user: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      cache: {
        findUnique: jest.fn(),
        create: jest.fn(),
        delete: jest.fn(),
      },
      request: {
        create: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
      },
    })),
  };
});

// Mock Discord.js
jest.mock('discord.js', () => ({
  Client: jest.fn().mockImplementation(() => ({
    login: jest.fn(),
    on: jest.fn(),
    user: { id: 'mock-bot-id' },
  })),
  Collection: jest.fn().mockImplementation(() => ({
    set: jest.fn(),
    get: jest.fn(),
  })),
}));

// Global teardown
afterAll(async () => {
  const prisma = new PrismaClient();
  const redis = new Redis();
  
  await prisma.$disconnect();
  redis.disconnect();
}); 