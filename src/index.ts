import express from "express";
import dotenv from "dotenv";
import { createClient } from "redis";
import connectDb from "./config/db.js";
import chatRoutes from "./routes/chat.js";
import cors from "cors";
import { app, server } from "./config/socket.js";

dotenv.config();

// Export Redis client for use in other files
export let redisClient: ReturnType<typeof createClient>;

const startServer = async () => {
  try {
    // Connect to MongoDB
    await connectDb();
    console.log("✅ Connected to MongoDB");

    // Connect to Redis
    if (process.env.REDIS_URL) {
      redisClient = createClient({
        url: process.env.REDIS_URL,
      });

      redisClient.on("error", (err) => console.error("❌ Redis error:", err));
      await redisClient.connect();
      console.log("✅ Connected to Redis");
    } else {
      console.log("⚠️ REDIS_URL not set, caching disabled");
    }

    app.use(express.json());

    app.use(
      cors({
        origin: [
          "http://localhost:3000",
          "https://the-pulse-chat-app.vercel.app",
        ],
        credentials: true,
      })
    );

    app.use("/api/v1", chatRoutes);

    const port = process.env.PORT || 5002;
    server.listen(port, () => {
      console.log(`🚀 Chat service running on port ${port}`);
    });
  } catch (err) {
    console.error("❌ Failed to start server", err);
    process.exit(1);
  }
};

startServer();
