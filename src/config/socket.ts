import { Server, Socket } from "socket.io";
import http from "http";
import { Messages } from "../models/Messages.js";
import express from "express";
import { Chat } from "../models/Chat.js";

const app = express();

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const userSocketMap: Record<string, string> = {};

export const getRecieverSocketId = (recieverId: string): string | undefined => {
  return userSocketMap[recieverId];
};

io.on("connection", (socket: Socket) => {
  console.log("🔌 User Connected", socket.id);
  console.log("🔍 Handshake query:", socket.handshake.query);

  const userId = socket.handshake.query.userId as string | undefined;
  console.log("🆔 Extracted userId:", userId);

  if (userId && userId !== "undefined") {
    userSocketMap[userId] = socket.id;
    console.log(`✅ User ${userId} mapped to socket ${socket.id}`);
    console.log("👥 Current userSocketMap:", Object.keys(userSocketMap));
  } else {
    console.log("❌ No valid userId found in socket connection");
  }

  io.emit("getOnlineUser", Object.keys(userSocketMap));

  if (userId) {
    socket.join(userId);
  }

  socket.on("typing", (data) => {
    socket.to(data.chatId).emit("userTyping", {
      chatId: data.chatId,
      userId: data.userId,
    });
  });

  console.log("🎯 Registering addReaction event handler for socket:", socket.id);
  
  socket.on("addReaction", async (data) => {
    console.log("🎉 Socket addReaction received:", data);
    console.log("📊 Socket ID:", socket.id);
    console.log("👤 Socket userId from handshake:", socket.handshake.query.userId);
    try {
      const { messageId, emoji } = data;
      const userId = socket.handshake.query.userId as string;

      console.log("Processing reaction:", { messageId, emoji, userId });

      if (!userId || !messageId || !emoji) {
        console.error("Missing data for reaction:", {
          userId,
          messageId,
          emoji,
        });
        return;
      }

      const message = await Messages.findById(messageId);
      if (!message) {
        console.error("Message not found:", messageId);
        return;
      }

      // Update reactions - use the same logic as the API endpoint
      const existingReactions = message.reactions || [];
      const existingIndex = existingReactions.findIndex(
        (r) => r.userId === userId && r.emoji === emoji
      );

      let newReactions;
      if (existingIndex > -1) {
        // Remove reaction if already exists
        newReactions = existingReactions.filter(
          (_, index) => index !== existingIndex
        );
      } else {
        // Remove any existing reaction by this user and add new one
        newReactions = existingReactions.filter((r) => r.userId !== userId);
        newReactions.push({ userId, emoji });
      }

      message.reactions = newReactions;
      await message.save();

      // Broadcast to all users in the chat room (including sender)
      const chatId = message.chatId.toString();
      console.log("Broadcasting reaction to chat room:", chatId);
      console.log("New reactions:", newReactions);
      
      io.to(chatId).emit("messageReaction", {
        messageId,
        reactions: newReactions,
      });
      
      // Also emit to individual user sockets to ensure delivery
      const chat = await Chat.findById(chatId);
      if (chat) {
        console.log("Chat users:", chat.users);
        chat.users.forEach(userId => {
          const userSocketId = getRecieverSocketId(userId);
          console.log(`User ${userId} has socket: ${userSocketId}`);
          if (userSocketId) {
            io.to(userSocketId).emit("messageReaction", {
              messageId,
              reactions: newReactions,
            });
          }
        });
      }

      console.log(
        `✅ Reaction updated for message ${messageId} by user ${userId}`
      );
    } catch (error) {
      console.error("Error handling reaction:", error);
    }
  });

  // REMOVED THE DUPLICATE replyToMessage HANDLER - using backend API instead

  socket.on("stopTyping", (data) => {
    socket.to(data.chatId).emit("userStoppedTyping", {
      chatId: data.chatId,
      userId: data.userId,
    });
  });

  socket.on("joinChat", (chatId) => {
    socket.join(chatId);
    console.log(`User ${userId} joined chat room ${chatId}`);
    
    // Confirm that the user has joined the room
    socket.emit("chatJoined", { chatId, userId });
  });

  socket.on("leaveChat", (chatId) => {
    socket.leave(chatId);
    console.log(`User ${userId} left chat room ${chatId}`);
  });

  socket.on("disconnect", () => {
    console.log("User Disconnected", socket.id);
    if (userId) {
      delete userSocketMap[userId];
      io.emit("getOnlineUser", Object.keys(userSocketMap));
    }
  });

  socket.on("connect_error", (error) => {
    console.log("Socket connection Error", error);
  });
});

export { app, server, io };
