
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const BOARD_SIZE = 200;
const MAX_INK = 20;
const INK_INTERVAL = 5000;
const PIXEL_SAVE_DELAY = 1000;

const DATA_DIR = process.env.DATA_DIR || __dirname;
const BOARD_FILE = path.join(DATA_DIR, "board.json");

fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/status", (req, res) => {
  res.json({
    name: "MARK",
    boardSize: BOARD_SIZE,
    maxInk: MAX_INK,
    inkInterval: INK_INTERVAL
  });
});

const io = new Server(server, {
  cors: {
    origin: [
      "https://mrpoggy573.github.io",
      "http://localhost:3000",
      "http://127.0.0.1:3000"
    ],
    methods: ["GET", "POST"]
  },
  transports: ["websocket", "polling"]
});

const COLORS = new Set([
  "#ffffff", "#c2c2c2", "#888888", "#444444",
  "#000000", "#ff0000", "#ff6a00", "#ffcc00",
  "#ffff00", "#80ff00", "#00cc44", "#00ffcc",
  "#00ccff", "#0066ff", "#6633ff", "#aa44ff",
  "#ff44cc", "#ff99cc", "#8b4513", "#ffb080",
  "#6b3e26", "#b7e4c7", "#f4a261", "#264653"
]);

let board = {};
let dirty = false;
let saveTimer = null;

const players = new Map();

function validPlayerId(value) {
  return typeof value === "string" &&
    /^[a-zA-Z0-9_-]{8,80}$/.test(value);
}

function loadBoard() {
  try {
    if (!fs.existsSync(BOARD_FILE)) {
      console.log("No saved board found. Starting a blank canvas.");
      return;
    }

    const saved = JSON.parse(fs.readFileSync(BOARD_FILE, "utf8"));

    if (saved && saved.version === 1 && saved.pixels) {
      for (const [key, color] of Object.entries(saved.pixels)) {
        const parts = key.split(",");
        const x = Number(parts[0]);
        const y = Number(parts[1]);

        if (
          parts.length === 2 &&
          Number.isInteger(x) &&
          Number.isInteger(y) &&
          x >= 0 && x < BOARD_SIZE &&
          y >= 0 && y < BOARD_SIZE &&
          COLORS.has(color)
        ) {
          board[key] = color;
        }
      }
    }

    console.log(`Loaded ${Object.keys(board).length} pixels.`);
  } catch (error) {
    console.error("Could not load the saved board:", error.message);
  }
}

function saveBoard() {
  if (!dirty) return;

  try {
    const temporaryFile = BOARD_FILE + ".tmp";

    fs.writeFileSync(
      temporaryFile,
      JSON.stringify({
        version: 1,
        width: BOARD_SIZE,
        height: BOARD_SIZE,
        pixels: board
      })
    );

    fs.renameSync(temporaryFile, BOARD_FILE);
    dirty = false;
  } catch (error) {
    console.error("Could not save board:", error.message);
  }
}

function scheduleSave() {
  dirty = true;

  if (saveTimer) return;

  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveBoard();
  }, PIXEL_SAVE_DELAY);
}

function getPlayer(playerId) {
  let player = players.get(playerId);

  if (!player) {
    player = {
      ink: MAX_INK,
      lastUpdate: Date.now(),
      name: "Player"
    };

    players.set(playerId, player);
  }

  return player;
}

function regenerateInk(player) {
  const now = Date.now();
  const elapsed = now - player.lastUpdate;
  const gained = Math.floor(elapsed / INK_INTERVAL);

  if (gained > 0) {
    player.ink = Math.min(MAX_INK, player.ink + gained);
    player.lastUpdate += gained * INK_INTERVAL;
  }

  if (player.ink >= MAX_INK) {
    player.lastUpdate = now;
  }

  return player.ink;
}

function sendInk(socket, playerId) {
  const player = getPlayer(playerId);
  regenerateInk(player);

  socket.emit("inkUpdate", {
    ink: player.ink,
    maxInk: MAX_INK,
    nextInkIn: player.ink >= MAX_INK
      ? 0
      : Math.max(0, INK_INTERVAL - (Date.now() - player.lastUpdate))
  });
}

function getOnlineCount() {
  return io.engine.clientsCount;
}

io.on("connection", (socket) => {
  socket.emit("boardInit", {
    size: BOARD_SIZE,
    pixels: board
  });

  socket.emit("onlineCount", getOnlineCount());

  socket.on("identify", (data) => {
    if (!data || !validPlayerId(data.id)) return;

    socket.data.playerId = data.id;

    const player = getPlayer(data.id);

    if (typeof data.name === "string") {
      player.name = data.name
        .replace(/[<>]/g, "")
        .trim()
        .slice(0, 16) || "Player";
    }

    sendInk(socket, data.id);
  });

  socket.on("requestInk", () => {
    if (!socket.data.playerId) return;
    sendInk(socket, socket.data.playerId);
  });

  socket.on("placePixel", (data) => {
    if (!socket.data.playerId || !data) return;

    const { x, y, color } = data;

    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      x < 0 || x >= BOARD_SIZE ||
      y < 0 || y >= BOARD_SIZE ||
      typeof color !== "string" ||
      !COLORS.has(color)
    ) {
      socket.emit("placementError", {
        message: "Invalid pixel placement."
      });
      return;
    }

    const player = getPlayer(socket.data.playerId);
    regenerateInk(player);

    if (player.ink < 1) {
      sendInk(socket, socket.data.playerId);

      socket.emit("placementError", {
        message: "You're out of ink. Wait for it to refill."
      });

      return;
    }

    const key = `${x},${y}`;

    if (board[key] === color) {
      socket.emit("placementError", {
        message: "That pixel is already this color."
      });
      return;
    }

    player.ink -= 1;

    if (player.ink < MAX_INK && player.ink === MAX_INK - 1) {
      player.lastUpdate = Date.now();
    }

    board[key] = color;
    scheduleSave();

    io.emit("pixelPlaced", {
      x,
      y,
      color,
      player: player.name
    });

    sendInk(socket, socket.data.playerId);
  });

  socket.on("disconnect", () => {
    io.emit("onlineCount", getOnlineCount());
  });

  io.emit("onlineCount", getOnlineCount());
});

loadBoard();

setInterval(() => {
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.playerId) {
      sendInk(socket, socket.data.playerId);
    }
  }
}, 1000);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`MARK is running on port ${PORT}`);
});

process.on("SIGTERM", () => {
  saveBoard();
  server.close(() => process.exit(0));
});

process.on("SIGINT", () => {
  saveBoard();
  server.close(() => process.exit(0));
});
