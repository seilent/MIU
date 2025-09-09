import http from 'http';
import { Socket } from 'net';
import logger from '../utils/logger.js';

export interface ServerWithConnectionTracking extends http.Server {
  closeAllConnections: () => void;
}

export function setupConnectionTracking(server: http.Server): ServerWithConnectionTracking {
  // Track all active connections to close them properly during shutdown
  const connections = new Map<string, Socket>();
  let connectionCounter = 0;
  
  // Track active connections
  server.on('connection', (socket) => {
    const id = String(connectionCounter++);
    connections.set(id, socket);
    
    // Remove connection from tracking when it closes naturally
    socket.on('close', () => {
      connections.delete(id);
    });
  });
  
  // Method to forcefully close active connections during shutdown
  const closeAllConnections = () => {
    if (connections.size > 0) {
      logger.info(`Forcefully closing ${connections.size} active connections`);
      for (const socket of connections.values()) {
        socket.destroy();
      }
      connections.clear();
    }
  };

  return Object.assign(server, { closeAllConnections });
}