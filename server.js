import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const PORT = process.env.PORT || 3500;

const ADMIN = "admin";
const server =  http.createServer(app);

const expressServer = app.listen(PORT, () => {
    console.log(`Express server running on port ${PORT}`);
  });

const io = new Server(server, {
  cors: {
    origin: process.env.NODE_ENV === "production" ? false : ["http://localhost:3000", "http://127.0.0.1:3000"],
    methods: ["GET", "POST"],
  },
});



