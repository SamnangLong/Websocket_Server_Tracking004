require("dotenv").config();

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const input = require("input");
const { v4: uuidv4 } = require("uuid");

// ===== Load and validate environment variables =====
const apiId = parseInt(process.env.API_ID, 10);
const apiHash = process.env.API_HASH;
const stringSession = new StringSession(process.env.SESSION || "");
const port = process.env.PORT || 8080;
const targetGroupId001 = process.env.TARGET_GROUP_ID001;
const targetPersonalUsername = process.env.TARGET_PERSONAL_USERNAME;

if (!apiId || !apiHash) {
  console.error("❌ API_ID and API_HASH must be set in .env");
  process.exit(1);
}

// ===== Initialize servers =====
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const clients = new Map(); // clientId → { ws, metadata }

function heartbeat() {
  this.isAlive = true;
}

// ===== WebSocket connection handler =====
wss.on("connection", (ws, req) => {
  const clientId = uuidv4();
  const clientIP = req.socket.remoteAddress;

  ws.isAlive = true;
  ws.on("pong", heartbeat);

  clients.set(clientId, {
    ws,
    metadata: {
      ip: clientIP,
      location_device: "🔄 Waiting...",
      lastSeen: new Date()
    }
  });

  ws.send(JSON.stringify({ type: "connected", clientId }));

  ws.on("message", (message) => {
    const text = message.toString();
    console.log(`📩 Message from ${clientId}: ${text}`);

    try {
      const data = JSON.parse(text);
      const clientData = clients.get(clientId);
      if (!clientData) return;

      const metadata = clientData.metadata;

      if (data.type === "connect") {
        const locationDevice = data.location_device || "Unknown";
        metadata.ip = data.ip || clientIP;
        metadata.location_device = locationDevice;
        metadata.lastSeen = new Date();

        clients.set(clientId, {
          ws,
          metadata
        });

        console.log(`🟢 Client registered: ${locationDevice} (${metadata.ip}) (Total: ${clients.size})`);

        if (telegramSelfUser) {
          telegramClient.sendMessage(telegramSelfUser, {
            message: `🟢 Client registered: ${locationDevice} (${metadata.ip}) (Total: ${clients.size})`
          });
        }
      } else if (data.type === "heartbeat") {
        metadata.lastSeen = new Date();
        console.log(`💓 Heartbeat from ${clientId} (${metadata.ip})`);
      } else {
        console.log(`🧠 Unknown message type from ${clientId}:`, data.type);
      }

    } catch (err) {
      console.error(`❌ Invalid JSON from ${clientId}:`, err.message);
    }
  });

  ws.on("close", () => {
    const clientData = clients.get(clientId);
    const ip = clientData?.metadata?.ip || "unknown";

    console.log(`🔴 Client disconnected: ${clientId} (${ip}) (Total: ${clients.size - 1})`);

    // if (telegramSelfUser) {
    //   telegramClient.sendMessage(telegramSelfUser, {
    //     message: `🔴 Client disconnected: ${clientId} (${ip}) (Total: ${clients.size - 1})`
    //   });
    // }

    clients.delete(clientId);
  });

  ws.on("error", (err) => {
    console.error(`⚠️ Error from ${clientId}:`, err.message);
  });
});

// ===== Broadcast helper =====
function broadcast(messageObj) {
  const data = JSON.stringify(messageObj);
  for (const { ws } of clients.values()) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

// ===== Heartbeat & cleanup intervals =====
setInterval(() => {
  broadcast({ type: "command", action: "ping" });
}, 30000);

setInterval(() => {
  const now = Date.now();
  for (const [clientId, { ws, metadata }] of clients.entries()) {
    if (now - new Date(metadata.lastSeen).getTime() > 30000) {
      console.log(`⏱️ Removing inactive client: ${clientId} (${metadata.ip})`);
      ws.terminate();
    }
  }
}, 10000);

// ===== Express routes =====
app.get("/", (req, res) => {
  res.send("🤖 Telegram WebSocket server is running!");
});

app.get("/esp32-clients", (req, res) => {
  const result = Array.from(clients.entries()).map(([clientId, { ws, metadata }]) => ({
    clientId,
    connected: ws.readyState === WebSocket.OPEN,
    ip: metadata.ip,
    location_device: metadata.location_device,
    lastSeen: metadata.lastSeen?.toISOString()
  }));
  res.json(result);
});

// ===== Start HTTP Server =====
server.listen(port, () => {
  console.log(`🌐 Server running at http://localhost:${port}`);
});

// ===== Telegram Setup =====
let telegramClient;
let telegramSelfUser;

(async () => {
  telegramClient = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5
  });

  try {
    await telegramClient.connect();

    await telegramClient.start({
      phoneNumber: async () => await input.text("☎️ Phone number: "),
      password: async () => await input.text("🔐 Password (if 2FA): "),
      phoneCode: async () => await input.text("📲 Enter code: "),
      onError: (err) => console.error("Telegram login error:", err)
    });

    telegramSelfUser = await telegramClient.getEntity(targetPersonalUsername);
    console.log("✅ Logged in as:", telegramSelfUser.username || telegramSelfUser.id);
    // console.log("🔐 SESSION STRING:\n", telegramClient.session.save());

    const dialogs = await telegramClient.getDialogs();
    const group = dialogs.find((d) => d.id.toString() === targetGroupId001);
    const targetEntities = [];

    if (targetPersonalUsername) {
      const user = await telegramClient.getEntity(targetPersonalUsername);
      targetEntities.push(user);
      console.log(`[Telegram] Monitoring user: ${user.username}`);
    }

    if (group) {
      targetEntities.push(group);
      console.log(`[Telegram] Listening to group: ${group.name}`);
    }

    const allowedChatIds = new Set(targetEntities.map((e) => e.id.toString()));

    // Telegram message handler
    telegramClient.addEventHandler(async (event) => {
      const msg = event.message;
      if (!msg || !msg.message) return;

      const chatId = msg.chatId?.toString();
      const senderId = msg.senderId?.toString() || "unknown";
      const text = msg.message;

      if (!allowedChatIds.has(chatId)) return;

      console.log(`📩 [Telegram] ${chatId} (${senderId}): ${text}`);

      const parts = text.split(":");
      if (parts.length >= 3 && parts[0].toLowerCase() === "esp32") {
        const clientID = parts[1];
        const command = parts.slice(2).join(":");

        for (const [clientId, clientData] of clients.entries()) {
          if (clientId === clientID && clientData.ws.readyState === WebSocket.OPEN) {
            clientData.ws.send(JSON.stringify({ clientID, message: command }));
            console.log(`📤 Sent to ESP32 (${clientID}): ${command}`);
          }
        }
      } else {
        broadcast({ from: chatId, sender: senderId, message: text });
      }
    }, new NewMessage({}));

  } catch (err) {
    console.error("❌ Telegram login failed:", err);
    process.exit(1);
  }
})();


