import { Server, Socket } from "socket.io";
import http from "http";
import axios from "axios";
import { Messages } from "../models/Messages.js";
import express from "express";
import { Chat } from "../models/Chat.js";

const app = express();

const server = http.createServer(app);

// User service URL with fallback for local development
const USER_SERVICE_URL = process.env.USER_SERVICE || "http://localhost:5000";

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const userSocketMap: Record<string, string> = {};

// Store user privacy settings in memory for quick access
const userPrivacySettings: Record<string, { showOnlineStatus: boolean }> = {};

export const getRecieverSocketId = (recieverId: string): string | undefined => {
  return userSocketMap[recieverId];
};

// Check if user wants to show online status
export const shouldShowOnlineStatus = (userId: string): boolean => {
  return userPrivacySettings[userId]?.showOnlineStatus !== false;
};

// Get filtered online users (only those who want to show their status)
const getFilteredOnlineUsers = (): string[] => {
  return Object.keys(userSocketMap).filter((userId) =>
    shouldShowOnlineStatus(userId)
  );
};

io.on("connection", async (socket: Socket) => {
  console.log("🔌 User Connected", socket.id);
  console.log("🔍 Handshake query:", socket.handshake.query);

  const userId = socket.handshake.query.userId as string | undefined;
  console.log("🆔 Extracted userId:", userId);

  if (userId && userId !== "undefined") {
    userSocketMap[userId] = socket.id;
    console.log(`✅ User ${userId} mapped to socket ${socket.id}`);
    console.log("👥 Current userSocketMap:", Object.keys(userSocketMap));

    // Fetch user's privacy settings
    try {
      const { data } = await axios.get(
        `${USER_SERVICE_URL}/api/v1/user/${userId}/public`
      );
      if (data?.privacySettings) {
        userPrivacySettings[userId] = {
          showOnlineStatus: data.privacySettings.showOnlineStatus,
        };
        console.log(
          `🔒 Privacy settings loaded for ${userId}:`,
          userPrivacySettings[userId]
        );
      }
    } catch (error) {
      console.log(`⚠️ Could not fetch privacy settings for ${userId}`);
      // Default to showing online status if we can't fetch settings
      userPrivacySettings[userId] = { showOnlineStatus: true };
    }
  } else {
    console.log("❌ No valid userId found in socket connection");
  }

  // Emit filtered online users (respecting privacy settings)
  io.emit("getOnlineUser", getFilteredOnlineUsers());

  if (userId) {
    socket.join(userId);
  }

  // Handle privacy settings update from client
  socket.on(
    "updatePrivacySettings",
    (settings: { showOnlineStatus: boolean }) => {
      if (userId) {
        userPrivacySettings[userId] = settings;
        console.log(`🔒 Privacy settings updated for ${userId}:`, settings);
        // Re-emit online users with updated privacy
        io.emit("getOnlineUser", getFilteredOnlineUsers());
      }
    }
  );

  socket.on("typing", (data) => {
    socket.to(data.chatId).emit("userTyping", {
      chatId: data.chatId,
      userId: data.userId,
    });
  });

  console.log(
    "🎯 Registering addReaction event handler for socket:",
    socket.id
  );

  socket.on("addReaction", async (data) => {
    console.log("🎉 Socket addReaction received:", data);
    console.log("📊 Socket ID:", socket.id);
    console.log(
      "👤 Socket userId from handshake:",
      socket.handshake.query.userId
    );
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
        chat.users.forEach((userId) => {
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

  socket.on("disconnect", async () => {
    console.log("User Disconnected", socket.id);
    if (userId) {
      delete userSocketMap[userId];
      delete userPrivacySettings[userId];

      // Update last seen in user service
      try {
        await axios.post(`${USER_SERVICE_URL}/api/v1/update-last-seen`, {
          userId,
        });
        console.log(`📅 Last seen updated for user ${userId}`);
      } catch (error: any) {
        console.log(
          `⚠️ Could not update last seen for ${userId}:`,
          error.message
        );
      }

      io.emit("getOnlineUser", getFilteredOnlineUsers());
    }
  });

  socket.on("connect_error", (error) => {
    console.log("Socket connection Error", error);
  });
});

export { app, server, io };
