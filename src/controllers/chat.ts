import axios from "axios";
import TryCatch from "../config/TryCatch.js";
import { AuthenticatedRequest } from "../middlewares/isAuth.js";
import { Chat } from "../models/Chat.js";
import { Messages } from "../models/Messages.js";
import { getRecieverSocketId, io } from "../config/socket.js";

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

  const chats = await Chat.find({ users: userId }).sort({ updatedAt: -1 });

  const chatWithUserData = await Promise.all(
    chats.map(async (chat) => {
      const otherUserId = chat.users.find((id) => id !== userId);

      const unseenCount = await Messages.countDocuments({
        chatId: chat._id,
        sender: { $ne: userId },
        seen: false,
      });

      try {
        const { data } = await axios.get(
          `${process.env.USER_SERVICE}/api/v1/user/${otherUserId}`
        );

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
        return {
          user: { _id: otherUserId, name: "Unknown User" },
          chat: {
            ...chat.toObject(),
            latestMessage: chat.latestMessage || null,
            unseenCount,
          },
        };
      }
    })
  );

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
    seenAt: isReceiverInChatRoom ? new Date() : undefined,
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

  // Emit to sockets
  io.to(chatId).emit("newMessage", finalMessage);

  if (receiverSocketId) {
    io.to(receiverSocketId).emit("newMessage", finalMessage);
  }

  const senderSocketId = getRecieverSocketId(senderId.toString());
  if (senderSocketId) {
    io.to(senderSocketId).emit("newMessage", finalMessage);
  }

  if (isReceiverInChatRoom && senderSocketId) {
    io.to(senderSocketId).emit("messagesSeen", {
      chatId: chatId,
      seenBy: otherUserId,
      messageIds: [finalMessage._id],
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

    // Mark messages as seen
    const messagesToMarkSeen = await Messages.find({
      chatId: chatId,
      sender: { $ne: userId },
      seen: false,
    });

    if (messagesToMarkSeen.length > 0) {
      await Messages.updateMany(
        {
          chatId: chatId,
          sender: { $ne: userId },
          seen: false,
        },
        {
          seen: true,
          seenAt: new Date(),
        }
      );
    }

    // Get messages with proper population
    const messages = await Messages.find({ chatId })
      .populate({
        path: "replyTo",
        select: "text sender messageType image",
      })
      .sort({ createdAt: 1 });

    // Convert to plain objects and ensure proper types
    const formattedMessages = messages.map((msg) => {
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

    const otherUserId = chat.users.find(
      (id) => id.toString() !== userId.toString()
    );

    // Socket notification for seen messages
    if (messagesToMarkSeen.length > 0 && otherUserId) {
      const otherUserSocketId = getRecieverSocketId(otherUserId.toString());
      if (otherUserSocketId) {
        io.to(otherUserSocketId).emit("messagesSeen", {
          chatId: chatId,
          seenBy: userId,
          messageIds: messagesToMarkSeen.map((msg) => msg._id),
        });
      }
    }

    try {
      let userData;
      if (otherUserId) {
        const { data } = await axios.get(
          `${process.env.USER_SERVICE}/api/v1/user/${otherUserId}`
        );
        userData = data;
      } else {
        userData = { _id: otherUserId, name: "Unknown User" };
      }

      res.json({
        messages: formattedMessages,
        user: userData,
      });
    } catch (error) {
      console.log(error);
      res.json({
        messages: formattedMessages,
        user: { _id: otherUserId, name: "Unknown User" },
      });
    }
  }
);

export const deleteMessage = TryCatch(async (req: AuthenticatedRequest, res) => {
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
  }

  res.json({
    message: "Message deleted successfully",
  });
});
