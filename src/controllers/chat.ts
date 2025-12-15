import axios from "axios";
import { getLinkPreview } from "link-preview-js";
import TryCatch from "../config/TryCatch.js";
import { AuthenticatedRequest } from "../middlewares/isAuth.js";
import { Chat } from "../models/Chat.js";
import { Messages, ILinkPreview } from "../models/Messages.js";
import { getRecieverSocketId, io } from "../config/socket.js";
import { cacheService } from "../services/CacheService.js";

// User service URL with fallback for local development
const USER_SERVICE_URL = process.env.USER_SERVICE || "http://localhost:5000";

// URL regex pattern for detecting links in text
const URL_REGEX = /(https?:\/\/[^\s<>"{}|\\^`\[\]]+)/gi;

// Helper function to extract first URL from text
const extractFirstUrl = (text: string): string | null => {
  const matches = text.match(URL_REGEX);
  return matches ? matches[0] : null;
};

// Helper function to fetch link preview data
const fetchLinkPreview = async (url: string): Promise<ILinkPreview | null> => {
  try {
    const data = await getLinkPreview(url, {
      timeout: 5000,
      headers: {
        "user-agent":
          "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      },
      followRedirects: "follow",
    });

    // Handle different response types
    if ("title" in data) {
      return {
        url: data.url,
        title: data.title || undefined,
        description: data.description || undefined,
        image: data.images?.[0] || undefined,
        siteName: data.siteName || undefined,
        favicon: data.favicons?.[0] || undefined,
      };
    }

    // For media types (images, videos, etc.)
    return {
      url: data.url,
      title: data.mediaType || "Link",
    };
  } catch (error) {
    console.log("Failed to fetch link preview:", error);
    return null;
  }
};

// Endpoint to fetch link preview (for real-time preview while typing)
export const getLinkPreviewData = TryCatch(
  async (req: AuthenticatedRequest, res) => {
    const { url } = req.query;

    if (!url || typeof url !== "string") {
      return res.status(400).json({
        message: "URL is required",
      });
    }

    const preview = await fetchLinkPreview(url);

    if (!preview) {
      return res.status(404).json({
        message: "Could not fetch preview for this URL",
      });
    }

    res.json({ preview });
  }
);

export const createNewChat = TryCatch(
  async (req: AuthenticatedRequest, res) => {
    const userId = req.user?._id;
    const { otherUserId } = req.body;

    if (!otherUserId) {
      res.status(400).json({
        message: "Other userid is required",
      });
      return;
    }

    const existingChat = await Chat.findOne({
      users: { $all: [userId, otherUserId], $size: 2 },
    });

    if (existingChat) {
      res.json({
        message: "Chat already exitst",
        chatId: existingChat._id,
      });
      return;
    }

    const newChat = await Chat.create({
      users: [userId, otherUserId],
    });

    // Invalidate cache for both users
    await cacheService.invalidate(
      cacheService.getChatsCacheKey(userId as string)
    );
    await cacheService.invalidate(cacheService.getChatsCacheKey(otherUserId));

    res.status(201).json({
      message: "New Chat created",
      chatId: newChat._id,
    });
  }
);

export const getAllChats = TryCatch(async (req: AuthenticatedRequest, res) => {
  const userId = req.user?._id;
  if (!userId) {
    res.status(400).json({
      message: " UserId missing",
    });
    return;
  }

  // Try to get cached chat data (user info for each chat)
  const cacheKey = cacheService.getChatsCacheKey(userId);
  const cachedData = await cacheService.get<
    {
      chatId: string;
      otherUserId: string;
      user: {
        _id: string;
        name: string;
        email?: string;
        profilePic?: { url?: string };
      };
      chat: object;
    }[]
  >(cacheKey);

  let chatWithUserData;

  if (cachedData) {
    // Cache HIT - We have cached user data, but need fresh unseen counts
    console.log(`📦 Cache HIT for user ${userId} chats`);

    chatWithUserData = await Promise.all(
      cachedData.map(async (item) => {
        // Get fresh unseen count
        const unseenCount = await Messages.countDocuments({
          chatId: item.chatId,
          sender: { $ne: userId },
          seen: false,
        });

        // Get fresh chat data (for latestMessage updates)
        const freshChat = await Chat.findById(item.chatId);

        return {
          user: item.user,
          chat: {
            ...(freshChat ? freshChat.toObject() : item.chat),
            latestMessage: freshChat?.latestMessage || null,
            unseenCount,
          },
        };
      })
    );
  } else {
    // Cache MISS - Fetch everything fresh
    console.log(`🔍 Cache MISS for user ${userId} chats - fetching from DB`);

    const chats = await Chat.find({ users: userId }).sort({ updatedAt: -1 });

    const dataToCache: {
      chatId: string;
      otherUserId: string;
      user: {
        _id: string;
        name: string;
        email?: string;
        profilePic?: { url?: string };
      };
      chat: object;
    }[] = [];

    chatWithUserData = await Promise.all(
      chats.map(async (chat) => {
        const otherUserId = chat.users.find((id) => id !== userId);

        const unseenCount = await Messages.countDocuments({
          chatId: chat._id,
          sender: { $ne: userId },
          seen: false,
        });

        try {
          const { data } = await axios.get(
            `${USER_SERVICE_URL}/api/v1/user/${otherUserId}`
          );

          // Store for caching (user data is expensive to fetch)
          dataToCache.push({
            chatId: String(chat._id),
            otherUserId: otherUserId as string,
            user: data,
            chat: chat.toObject(),
          });

          return {
            user: data,
            chat: {
              ...chat.toObject(),
              latestMessage: chat.latestMessage || null,
              unseenCount,
            },
          };
        } catch (error) {
          console.log(error);
          const fallbackUser = {
            _id: otherUserId as string,
            name: "Unknown User",
          };

          dataToCache.push({
            chatId: String(chat._id),
            otherUserId: otherUserId as string,
            user: fallbackUser,
            chat: chat.toObject(),
          });

          return {
            user: fallbackUser,
            chat: {
              ...chat.toObject(),
              latestMessage: chat.latestMessage || null,
              unseenCount,
            },
          };
        }
      })
    );

    // Cache the data for 5 minutes (300 seconds) - user data doesn't change often
    await cacheService.set(cacheKey, dataToCache, 300);
    console.log(`💾 Cached chat data for user ${userId}`);
  }

  res.json({
    chats: chatWithUserData,
  });
});

export const addReaction = TryCatch(async (req: AuthenticatedRequest, res) => {
  const userId = req.user?._id;
  const { messageId, emoji } = req.body;

  if (!userId || !messageId || !emoji) {
    return res.status(400).json({
      message: "User ID, message ID, and emoji are required",
    });
  }

  const message = await Messages.findById(messageId);
  if (!message) {
    return res.status(404).json({
      message: "Message not found",
    });
  }

  // Update reactions - remove any existing reaction by this user first
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

  // Emit socket event
  const chatId = message.chatId.toString();
  io.to(chatId).emit("messageReaction", {
    messageId,
    reactions: newReactions,
  });

  res.json({
    message: "Reaction updated",
    reactions: newReactions,
  });
});

export const getMessageWithReplies = TryCatch(
  async (req: AuthenticatedRequest, res) => {
    const { messageId } = req.params;

    const message = await Messages.findById(messageId)
      .populate("replyTo", "text sender createdAt messageType image")
      .populate("forwardedFrom", "name");

    if (!message) {
      return res.status(404).json({
        message: "Message not found",
      });
    }

    res.json(message);
  }
);

export const sendMessage = TryCatch(async (req: AuthenticatedRequest, res) => {
  const senderId = req.user?._id;
  const { chatId, text, replyTo } = req.body;
  const imageFile = req.file;

  if (!senderId) {
    res.status(401).json({
      message: "unauthorized",
    });
    return;
  }
  if (!chatId) {
    res.status(400).json({
      message: "ChatId Required",
    });
    return;
  }

  if (!text && !imageFile) {
    res.status(400).json({
      message: "Either text or image is required",
    });
    return;
  }

  const chat = await Chat.findById(chatId);
  if (!chat) {
    res.status(404).json({
      message: "Chat not found",
    });
    return;
  }

  const isUserInChat = chat.users.some(
    (userId) => userId.toString() === senderId.toString()
  );
  if (!isUserInChat) {
    res.status(403).json({
      message: "You are not a participant of this chat",
    });
    return;
  }

  const otherUserId = chat.users.find(
    (userId) => userId.toString() !== senderId.toString()
  );
  if (!otherUserId) {
    res.status(401).json({
      message: "No other user",
    });
    return;
  }

  // Fetch privacy settings for both users to check read receipts (in parallel)
  const [senderPrivacyResult, receiverPrivacyResult] = await Promise.allSettled(
    [
      axios.get(`${USER_SERVICE_URL}/api/v1/user/${senderId}/public`),
      axios.get(`${USER_SERVICE_URL}/api/v1/user/${otherUserId}/public`),
    ]
  );

  let senderPrivacy = { showReadReceipts: true };
  let receiverPrivacy = { showReadReceipts: true };

  if (senderPrivacyResult.status === "fulfilled") {
    senderPrivacy = senderPrivacyResult.value.data.privacySettings || {
      showReadReceipts: true,
    };
  }

  if (receiverPrivacyResult.status === "fulfilled") {
    receiverPrivacy = receiverPrivacyResult.value.data.privacySettings || {
      showReadReceipts: true,
    };
  }

  // Both users must have read receipts enabled for seenAt to be set
  const bothAllowReadReceipts =
    senderPrivacy.showReadReceipts && receiverPrivacy.showReadReceipts;

  // Socket setup
  const receiverSocketId = getRecieverSocketId(otherUserId.toString());
  let isReceiverInChatRoom = false;

  if (receiverSocketId) {
    const receiverSocket = io.sockets.sockets.get(receiverSocketId);
    if (receiverSocket && receiverSocket.rooms.has(chatId)) {
      isReceiverInChatRoom = true;
    }
  }

  let messageData: any = {
    chatId: chatId,
    sender: senderId,
    seen: isReceiverInChatRoom,
    // Only set seenAt if BOTH users have read receipts enabled
    seenAt:
      isReceiverInChatRoom && bothAllowReadReceipts ? new Date() : undefined,
  };

  // Handle reply
  if (replyTo) {
    console.log("Processing reply message:", { replyTo, senderId });
    messageData.replyTo = replyTo;
    messageData.messageType = "reply";

    // Get the replied message and convert to basic type
    const repliedMessage = await Messages.findById(replyTo).select(
      "text sender messageType image"
    );
    console.log("Found replied message:", repliedMessage);

    if (repliedMessage) {
      // Convert to basic message type for quoted content
      let quotedMessageType: "text" | "image" | "deleted" = "text";
      if (repliedMessage.messageType === "image") {
        quotedMessageType = "image";
      } else if (repliedMessage.messageType === "deleted") {
        quotedMessageType = "deleted";
      }

      messageData.repliedMessage = {
        _id: repliedMessage._id,
        text: repliedMessage.text || "",
        sender: repliedMessage.sender.toString(),
        messageType: quotedMessageType,
        image: repliedMessage.image || undefined,
      };
    }
  }

  // Handle image and text
  if (imageFile) {
    messageData.image = {
      url: imageFile.path,
      publicId: imageFile.filename,
    };
    messageData.messageType = replyTo ? "reply" : "image";
    messageData.text = text || "";
  } else {
    messageData.text = text;
    messageData.messageType = replyTo ? "reply" : "text";
  }

  // Save message immediately for fast response
  const message = new Messages(messageData);
  const savedMessage = await message.save();

  // Refresh to get populated data if needed
  const finalMessage = await Messages.findById(savedMessage._id);
  if (!finalMessage) {
    res.status(500).json({
      message: "Failed to save message",
    });
    return;
  }

  // Fetch link preview AFTER saving and responding (non-blocking)
  if (text && !imageFile) {
    const firstUrl = extractFirstUrl(text);
    if (firstUrl) {
      // Don't await - fetch in background
      fetchLinkPreview(firstUrl)
        .then(async (linkPreview) => {
          if (linkPreview) {
            // Update message with link preview asynchronously
            const updatedMessage = await Messages.findByIdAndUpdate(
              savedMessage._id,
              { $set: { linkPreview: linkPreview } },
              { new: true }
            );

            // Emit updated message with preview to both users
            if (updatedMessage) {
              io.to(chatId).emit("messageUpdated", updatedMessage);
              if (receiverSocketId) {
                io.to(receiverSocketId).emit("messageUpdated", updatedMessage);
              }
              const senderSocketId = getRecieverSocketId(senderId.toString());
              if (senderSocketId) {
                io.to(senderSocketId).emit("messageUpdated", updatedMessage);
              }
            }
          }
        })
        .catch((err) => {
          console.log("Link preview fetch failed (non-critical):", err.message);
        });
    }
  }

  let latestMessageText = imageFile ? "📷 Image" : text;
  if (replyTo) {
    latestMessageText = `↩️ ${text}`;
  }

  await Chat.findByIdAndUpdate(
    chatId,
    {
      latestMessage: {
        text: latestMessageText,
        sender: senderId,
      },
      updatedAt: new Date(),
    },
    { new: true }
  );

  // Invalidate cache in background (non-blocking)
  Promise.all([
    cacheService.invalidate(cacheService.getChatsCacheKey(senderId)),
    cacheService.invalidate(
      cacheService.getChatsCacheKey(otherUserId.toString())
    ),
  ]).catch((err) =>
    console.log("Cache invalidation error (non-critical):", err.message)
  );

  // Emit to sockets immediately
  io.to(chatId).emit("newMessage", finalMessage);

  if (receiverSocketId) {
    io.to(receiverSocketId).emit("newMessage", finalMessage);
  }

  const senderSocketId = getRecieverSocketId(senderId.toString());
  if (senderSocketId) {
    io.to(senderSocketId).emit("newMessage", finalMessage);
  }

  // Only emit messagesSeen if BOTH users have read receipts enabled
  if (isReceiverInChatRoom && senderSocketId && bothAllowReadReceipts) {
    io.to(senderSocketId).emit("messagesSeen", {
      chatId: chatId,
      seenBy: otherUserId,
      messageIds: [finalMessage._id],
      seenAt: new Date(),
    });
  }

  res.status(201).json({
    message: finalMessage,
    sender: senderId,
  });
});

export const getMessagesByChat = TryCatch(
  async (req: AuthenticatedRequest, res) => {
    const userId = req.user?._id;
    const { chatId } = req.params;

    // Pagination params - default to last 50 messages
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const skip = (page - 1) * limit;

    if (!userId) {
      res.status(401).json({
        message: "Unauthorized",
      });
      return;
    }
    if (!chatId) {
      res.status(400).json({
        message: "ChatId Required",
      });
      return;
    }

    const chat = await Chat.findById(chatId);
    if (!chat) {
      res.status(404).json({
        message: "Chat not found",
      });
      return;
    }

    const isUserInChat = chat.users.some(
      (id) => id.toString() === userId.toString()
    );
    if (!isUserInChat) {
      res.status(403).json({
        message: "You are not a participant of this chat",
      });
      return;
    }

    // Get other user to check their privacy settings
    const otherUserId = chat.users.find(
      (id) => id.toString() !== userId.toString()
    );

    // Fetch current user's privacy settings to check if they allow read receipts
    let currentUserPrivacy = { showReadReceipts: true };
    let otherUserPrivacy = { showReadReceipts: true };

    try {
      const { data: currentUserData } = await axios.get(
        `${USER_SERVICE_URL}/api/v1/user/${userId}/public`
      );
      currentUserPrivacy = currentUserData.privacySettings || {
        showReadReceipts: true,
      };
    } catch (error) {
      console.log("Could not fetch current user privacy settings");
    }

    if (otherUserId) {
      try {
        const { data: otherUserData } = await axios.get(
          `${USER_SERVICE_URL}/api/v1/user/${otherUserId}/public`
        );
        otherUserPrivacy = otherUserData.privacySettings || {
          showReadReceipts: true,
        };
      } catch (error) {
        console.log("Could not fetch other user privacy settings");
      }
    }
    // Mark messages as seen (only for first page / initial load)
    // Only update seenAt if BOTH users have read receipts enabled
    const bothAllowReadReceipts =
      currentUserPrivacy.showReadReceipts && otherUserPrivacy.showReadReceipts;

    if (page === 1) {
      const messagesToMarkSeen = await Messages.find({
        chatId: chatId,
        sender: { $ne: userId },
        seen: false,
      });

      if (messagesToMarkSeen.length > 0) {
        // Always mark as seen internally, but only set seenAt if both allow read receipts
        await Messages.updateMany(
          {
            chatId: chatId,
            sender: { $ne: userId },
            seen: false,
          },
          {
            seen: true,
            ...(bothAllowReadReceipts ? { seenAt: new Date() } : {}),
          }
        );

        // Only emit messagesSeen event if BOTH users have read receipts enabled
        if (bothAllowReadReceipts && otherUserId) {
          const otherUserSocketId = getRecieverSocketId(otherUserId.toString());
          if (otherUserSocketId) {
            io.to(otherUserSocketId).emit("messagesSeen", {
              chatId: chatId,
              seenBy: userId,
              messageIds: messagesToMarkSeen.map((msg) => msg._id),
              seenAt: new Date(),
            });
          }
        }
      }
    }

    // Get total count for pagination info
    const totalMessages = await Messages.countDocuments({ chatId });
    const totalPages = Math.ceil(totalMessages / limit);
    const hasMore = page < totalPages;

    // Get messages with pagination (newest first for loading, then reverse for display)
    // We sort by createdAt: -1 to get newest first, skip older ones, then reverse
    const messages = await Messages.find({ chatId })
      .populate({
        path: "replyTo",
        select: "text sender messageType image",
      })
      .sort({ createdAt: -1 }) // Newest first
      .skip(skip)
      .limit(limit);

    // Reverse to get chronological order for display
    const chronologicalMessages = messages.reverse();

    // Convert to plain objects and ensure proper types
    const formattedMessages = chronologicalMessages.map((msg) => {
      const messageObj = msg.toObject();

      // Ensure repliedMessage has correct structure if it exists
      if (messageObj.repliedMessage && messageObj.repliedMessage._id) {
        const repliedMsg = messageObj.repliedMessage;

        // Convert to basic message type if needed
        let quotedMessageType: "text" | "image" | "deleted" = "text";
        if (repliedMsg.messageType === "image") {
          quotedMessageType = "image";
        } else if (repliedMsg.messageType === "deleted") {
          quotedMessageType = "deleted";
        }

        messageObj.repliedMessage = {
          _id: repliedMsg._id,
          text: repliedMsg.text || "",
          sender: repliedMsg.sender?.toString() || "",
          messageType: quotedMessageType,
          image: repliedMsg.image || undefined,
        };
      }

      return messageObj;
    });

    // Fetch user data - don't cache lastSeen since it changes frequently
    // Note: otherUserId is already defined above
    let userData;
    if (otherUserId) {
      try {
        // Use the public profile endpoint which is privacy-aware
        const fullUrl = `${USER_SERVICE_URL}/api/v1/user/${otherUserId}/public`;
        console.log(`🌐 Fetching user from: ${fullUrl}`);

        const { data } = await axios.get(fullUrl);
        userData = data;
        console.log(`🔍 Fetched user data for ${otherUserId}:`, {
          name: data.name,
          lastSeen: data.lastSeen,
          showLastSeen: data.privacySettings?.showLastSeen,
        });
      } catch (error: any) {
        console.log("❌ Error fetching user:", error.message);
        console.log("❌ Error details:", error.response?.data || error.code);
        userData = { _id: otherUserId, name: "Unknown User" };
      }
    } else {
      userData = { _id: otherUserId, name: "Unknown User" };
    }

    res.json({
      messages: formattedMessages,
      user: userData,
      pagination: {
        page,
        limit,
        totalMessages,
        totalPages,
        hasMore,
      },
    });
  }
);

export const deleteMessage = TryCatch(
  async (req: AuthenticatedRequest, res) => {
    const userId = req.user?._id;
    const { messageId } = req.params;

    if (!userId) {
      return res.status(401).json({
        message: "Unauthorized",
      });
    }

    if (!messageId) {
      return res.status(400).json({
        message: "Message ID is required",
      });
    }

    const message = await Messages.findById(messageId);
    if (!message) {
      return res.status(404).json({
        message: "Message not found",
      });
    }

    // Check if user is the sender of the message
    if (message.sender.toString() !== userId.toString()) {
      return res.status(403).json({
        message: "You can only delete your own messages",
      });
    }

    // Update message to deleted state instead of removing it
    message.messageType = "deleted";
    message.text = "";
    message.image = undefined;
    message.reactions = []; // Clear all reactions when message is deleted
    await message.save();

    // Emit socket event
    const chatId = message.chatId.toString();
    const deletedMessageData = {
      messageId: message._id,
      chatId,
      _id: message._id,
      messageType: "deleted",
      text: "",
      image: undefined,
      sender: message.sender,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      reactions: [], // Always empty for deleted messages
      seen: message.seen,
      seenAt: message.seenAt,
    };

    console.log("📤 Emitting messageDeleted event:", deletedMessageData);
    io.to(chatId).emit("messageDeleted", deletedMessageData);

    // Update chat's latest message if this was the latest message
    const chat = await Chat.findById(chatId);
    if (chat && chat.latestMessage.text !== "Message deleted") {
      await Chat.findByIdAndUpdate(chatId, {
        latestMessage: {
          text: "Message deleted",
          sender: userId,
        },
      });

      // Invalidate cache for both users
      for (const participantId of chat.users) {
        await cacheService.invalidate(
          cacheService.getChatsCacheKey(participantId)
        );
      }
    }

    res.json({
      message: "Message deleted successfully",
    });
  }
);

export const editMessage = TryCatch(async (req: AuthenticatedRequest, res) => {
  const userId = req.user?._id;
  const { messageId } = req.params;
  const { text } = req.body;

  if (!userId) {
    return res.status(401).json({
      message: "Unauthorized",
    });
  }

  if (!messageId) {
    return res.status(400).json({
      message: "Message ID is required",
    });
  }

  if (!text || !text.trim()) {
    return res.status(400).json({
      message: "Message text is required",
    });
  }

  const message = await Messages.findById(messageId);
  if (!message) {
    return res.status(404).json({
      message: "Message not found",
    });
  }

  // Check if user is the sender of the message
  if (message.sender.toString() !== userId.toString()) {
    return res.status(403).json({
      message: "You can only edit your own messages",
    });
  }

  // Check if message is deleted
  if (message.messageType === "deleted") {
    return res.status(400).json({
      message: "Cannot edit a deleted message",
    });
  }

  // Check if message has an image (image-only messages cannot be edited to text-only)
  if (message.messageType === "image" && !message.text) {
    return res.status(400).json({
      message: "Cannot edit image-only messages",
    });
  }

  // Check if message is within 15 minutes edit window
  const messageCreatedAt = new Date(message.createdAt).getTime();
  const currentTime = Date.now();
  const fifteenMinutesInMs = 15 * 60 * 1000; // 15 minutes in milliseconds

  if (currentTime - messageCreatedAt > fifteenMinutesInMs) {
    return res.status(400).json({
      message: "Messages can only be edited within 15 minutes of sending",
    });
  }

  // Update the message
  message.text = text.trim();
  message.isEdited = true;
  message.editedAt = new Date();
  await message.save();

  // Emit socket event to notify all users in the chat
  const chatId = message.chatId.toString();
  const editedMessageData = {
    messageId: message._id,
    chatId,
    _id: message._id,
    text: message.text,
    isEdited: true,
    editedAt: message.editedAt,
    messageType: message.messageType,
    sender: message.sender,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    reactions: message.reactions,
    seen: message.seen,
    seenAt: message.seenAt,
    image: message.image,
    replyTo: message.replyTo,
    repliedMessage: message.repliedMessage,
  };

  console.log("📝 Emitting messageEdited event:", editedMessageData);
  io.to(chatId).emit("messageEdited", editedMessageData);

  // Also emit to individual user sockets to ensure delivery
  const chat = await Chat.findById(chatId);
  if (chat) {
    chat.users.forEach((chatUserId) => {
      const userSocketId = getRecieverSocketId(chatUserId);
      if (userSocketId) {
        io.to(userSocketId).emit("messageEdited", editedMessageData);
      }
    });
  }

  // Update chat's latest message if this was the latest message
  const latestMessage = await Messages.findOne({ chatId })
    .sort({ createdAt: -1 })
    .limit(1);

  if (latestMessage && (latestMessage._id as any).toString() === messageId) {
    await Chat.findByIdAndUpdate(chatId, {
      latestMessage: {
        text: message.text,
        sender: userId,
      },
    });

    // Invalidate cache for both users if latest message was edited
    if (chat) {
      for (const participantId of chat.users) {
        await cacheService.invalidate(
          cacheService.getChatsCacheKey(participantId)
        );
      }
    }
  }

  res.json({
    message: "Message edited successfully",
    editedMessage: editedMessageData,
  });
});

// Debug endpoint to check cache status (remove in production)
export const getCacheStatus = TryCatch(
  async (req: AuthenticatedRequest, res) => {
    const userId = req.user?._id;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const cacheKey = cacheService.getChatsCacheKey(userId);
    const cachedData = await cacheService.get(cacheKey);

    res.json({
      cacheKey,
      isCached: !!cachedData,
      cachedItemsCount: cachedData ? (cachedData as unknown[]).length : 0,
      message: cachedData
        ? "✅ Cache HIT - Data is cached"
        : "❌ Cache MISS - No cached data",
    });
  }
);
