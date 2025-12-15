import express from "express";
import isAuth from "../middlewares/isAuth.js";
import {
  createNewChat,
  getAllChats,
  getMessagesByChat,
  sendMessage,
  addReaction,
  getMessageWithReplies,
  deleteMessage,
  editMessage,
  getLinkPreviewData,
  getCacheStatus,
} from "../controllers/chat.js";
import { upload } from "../middlewares/multer.js";

const router = express.Router();

router.post("/chat/new", isAuth, createNewChat);
router.get("/chat/all", isAuth, getAllChats);
router.post("/message", isAuth, upload.single("image"), sendMessage);
router.get("/message/:chatId", isAuth, getMessagesByChat);
router.post("/message/reaction", isAuth, addReaction);
router.get("/message/details/:messageId", isAuth, getMessageWithReplies);
router.delete("/messages/:messageId", isAuth, deleteMessage);
router.put("/messages/:messageId", isAuth, editMessage);
router.get("/link-preview", isAuth, getLinkPreviewData);
router.get("/cache-status", isAuth, getCacheStatus); // Debug endpoint

export default router;
