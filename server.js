import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const PORT = process.env.PORT || 3500;

// Create HTTP server
const server = http.createServer(app);

// Initialize Socket.io with the HTTP server (not Express app)
const io = new Server(server, {
  cors: {
    origin: process.env.NODE_ENV === "production" 
      ? false 
      : ["http://localhost:3000", "http://127.0.0.1:3000"],
    methods: ["GET", "POST"],
  },
});

// In-memory room state
// rooms structure:
// {
//   "ROOMCODE": {
//     users: { // Object keyed by username
//       "username1": {
//         username: "username1",
//         socketIds: ["socketId1", "socketId2"] // List of active socket IDs for this user
//       },
//       "username2": {
//         username: "username2",
//         socketIds: ["socketId3"]
//       }
//     },
//     messages: [],
//     createdAt: Date.now()
//   }
// }
const rooms = {};

// Helper function to get a simplified list of users for frontend
// This ensures the frontend receives a consistent format
function getFrontendUsers(room) {
  if (!room || !room.users) return [];
  return Object.values(room.users).map(userEntry => ({
    // For simplicity, we'll just use the first socketId as the 'id' for frontend display.
    // The backend still tracks all active sockets.
    id: userEntry.socketIds[0], 
    username: userEntry.username
  }));
}

// Basic health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', rooms: Object.keys(rooms).length });
});

io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Create Room
  socket.on("createRoom", ({ username }, callback) => {
    try {
      let roomCode;
      do {
        roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
      } while (rooms[roomCode]);

      // Initialize room with the creator's username and their socket ID
      rooms[roomCode] = { 
        users: { 
          [username]: { // Key the user by their username
            username: username,
            socketIds: [socket.id] // Store this socket's ID for the user
          }
        }, 
        messages: [],
        createdAt: Date.now()
      };
      
      socket.join(roomCode);
      // Store the roomCode on the socket for easier disconnect handling
      socket.data.currentRoomCode = roomCode; 
      socket.data.username = username; // Store username on socket for disconnect
      
      callback({ success: true, roomCode });
      console.log(`Room created: ${roomCode} by ${username}`);
      
      // Emit roomUpdate with a list of users in frontend format
      io.to(roomCode).emit("roomUpdate", { users: getFrontendUsers(rooms[roomCode]) });
    } catch (error) {
      console.error('Error creating room:', error);
      callback({ success: false, error: "Failed to create room" });
    }
  });

  // Join Room
  socket.on("joinRoom", ({ roomCode, username }, callback) => {
    try {
      const room = rooms[roomCode];
      if (!room) {
        return callback({ success: false, error: "Room not found" });
      }
      
      // Check if maximum number of unique users (by username) has been reached
      if (Object.keys(room.users).length >= 4 && !room.users[username]) {
        return callback({ success: false, error: "Room is full" });
      }

      // If user (by username) is already in the room
      if (room.users[username]) {
        // Add this new socket ID to the user's list if not already present
        if (!room.users[username].socketIds.includes(socket.id)) {
          room.users[username].socketIds.push(socket.id);
          console.log(`User ${username} re-joined room ${roomCode} with new socket ${socket.id}`);
        } else {
          console.log(`User ${username} (socket ${socket.id}) already present in room ${roomCode}`);
        }
      } else {
        // New unique user joining
        room.users[username] = {
          username: username,
          socketIds: [socket.id]
        };
        console.log(`New user ${username} joined room: ${roomCode} with socket ${socket.id}`);
      }
      
      socket.join(roomCode);
      // Store the roomCode and username on the socket for easier disconnect handling
      socket.data.currentRoomCode = roomCode;
      socket.data.username = username;

      callback({ success: true, roomCode });
      
      // Emit roomUpdate with the updated list of users
      io.to(roomCode).emit("roomUpdate", { users: getFrontendUsers(room) });
    } catch (error) {
      console.error('Error joining room:', error);
      callback({ success: false, error: "Failed to join room" });
    }
  });

  // Leave Room - triggered when user explicitly clicks "Leave Room"
  socket.on("leaveRoom", ({ roomCode }, callback) => {
    try {
      const room = rooms[roomCode];
      // Get the username associated with this socket
      const username = socket.data.username; 

      if (room && username && room.users[username]) {
        // Remove this specific socket ID from the user's active sockets
        room.users[username].socketIds = room.users[username].socketIds.filter(id => id !== socket.id);
        
        // If the user has no more active sockets for this room, remove the user from the room entirely
        if (room.users[username].socketIds.length === 0) {
          delete room.users[username];
          console.log(`User ${username} explicitly left room ${roomCode} and has no more active sockets.`);
        } else {
          console.log(`User ${username} explicitly left room ${roomCode} but still has other active sockets.`);
        }

        socket.leave(roomCode);
        socket.data.currentRoomCode = undefined; // Clear room association on socket
        socket.data.username = undefined;

        if (Object.keys(room.users).length === 0) { // If no unique users left in the room
          delete rooms[roomCode];
          console.log(`Room ${roomCode} deleted - no users left after explicit leave.`);
        } else {
          io.to(roomCode).emit("roomUpdate", { users: getFrontendUsers(room) });
        }
      } else {
        console.log(`Leave room request for non-existent room ${roomCode} or unknown user ${username}.`);
      }
      console.log(`User ${username || socket.id} processed leave room for: ${roomCode}`);
      callback && callback({ success: true });
    } catch (error) {
      console.error('Error leaving room:', error);
      callback && callback({ success: false, error: "Failed to leave room" });
    }
  });

  // Chat Message
  socket.on("chatMessage", ({ roomCode, username, message }) => {
    try {
      const room = rooms[roomCode];
      if (!room) {
        console.log(`Message sent to non-existent room: ${roomCode}`);
        return;
      }

      // Verify user is in the room by username AND this specific socket is active for them
      const userInRoom = room.users[username];
      if (!userInRoom || !userInRoom.socketIds.includes(socket.id)) {
        console.log(`User ${username} (socket ${socket.id}) attempted to send message to room ${roomCode} but is not a valid participant.`);
        return;
      }

      const msg = { username, message: message.trim(), time: Date.now() };
      room.messages.push(msg);
      
      // Keep only last 100 messages to prevent memory issues
      if (room.messages.length > 100) {
        room.messages = room.messages.slice(-100);
      }

      console.log(`Message from ${username} in room ${roomCode}: ${message}`);
      io.to(roomCode).emit("chatMessage", msg);
    } catch (error) {
      console.error('Error sending message:', error);
    }
  });

  // Handle disconnect - triggered when a socket connection breaks
  socket.on("disconnect", (reason) => {
    console.log(`User disconnected: ${socket.id} (Reason: ${reason})`);
    
    // Retrieve roomCode and username from socket.data
    const roomCode = socket.data.currentRoomCode;
    const username = socket.data.username;

    if (roomCode && rooms[roomCode] && username && rooms[roomCode].users[username]) {
      const room = rooms[roomCode];
      const userEntry = room.users[username];

      // Remove this specific socket ID from the user's active sockets
      userEntry.socketIds = userEntry.socketIds.filter(id => id !== socket.id);
      console.log(`Removed socket ${socket.id} from user ${username} in room ${roomCode}. Remaining sockets for user: ${userEntry.socketIds.length}`);

      if (userEntry.socketIds.length === 0) {
        // If this user (by username) has no more active sockets in this room, remove the user
        delete room.users[username];
        console.log(`User ${username} has no active sockets left in room ${roomCode}, user removed from room's user list.`);
      }

      if (Object.keys(room.users).length === 0) {
        // If the room now has no unique users left, delete the room
        delete rooms[roomCode];
        console.log(`Room ${roomCode} deleted - no unique users left after disconnect cleanup.`);
      } else {
        // If the room still has unique users, send an update to remaining clients
        io.to(roomCode).emit("roomUpdate", { users: getFrontendUsers(room) });
        console.log(`Room ${roomCode} updated after disconnect. Current users: ${Object.keys(room.users).join(', ')}`);
      }
    } else {
        console.log(`Disconnected socket ${socket.id} was not associated with an active room or username, or room no longer exists.`);
    }
  });
});

// Start the server using the HTTP server, not Express app
server.listen(PORT, () => {
  console.log(`Socket.io server running on port ${PORT}`);
});

export default server;