const WebSocket = require('ws');

class SocketService {
  constructor() {
    this.wss = null;
    this.connections = new Map(); // userId -> Set of WebSocket connections
  }

  initialize(server) {
    this.wss = new WebSocket.Server({ server });
    
    this.wss.on('connection', (ws, req) => {
      // Extract userId from the request (you'll need to implement proper auth)
      const userId = req.headers['user-id'];
      
      if (!userId) {
        ws.close(4001, 'User ID required');
        return;
      }

      // Add connection to the user's set
      if (!this.connections.has(userId)) {
        this.connections.set(userId, new Set());
      }
      this.connections.get(userId).add(ws);

      // Handle connection close
      ws.on('close', () => {
        const userConnections = this.connections.get(userId);
        if (userConnections) {
          userConnections.delete(ws);
          if (userConnections.size === 0) {
            this.connections.delete(userId);
          }
        }
      });
    });
  }

  notifyUser(userId, eventType, data) {
    const userConnections = this.connections.get(userId);
    if (!userConnections) return;

    const message = JSON.stringify({
      type: eventType,
      data,
      timestamp: new Date().toISOString()
    });

    userConnections.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    });
  }

  notifySettingsChange(userId, settings) {
    this.notifyUser(userId, 'settings_updated', settings);
  }

  notifySyncStatus(userId, status) {
    this.notifyUser(userId, 'sync_status', status);
  }
}

module.exports = SocketService; 