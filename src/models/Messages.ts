import mongoose, { Document, Schema, Types } from "mongoose";

export interface ILinkPreview {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  favicon?: string;
}

export interface IMessage extends Document {
  chatId: Types.ObjectId;
  sender: string;
  text?: string;
  image?: {
    url: string;
    publicId: string;
  };
  messageType: "text" | "image" | "deleted" | "reply" | "forward";
  seen: boolean;
  seenAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  reactions?: {
    userId: string;
    emoji: string;
  }[];
  replyTo?: Types.ObjectId;
  forwardedFrom?: string;
  repliedMessage?: {
    _id: Types.ObjectId;
    text?: string;
    sender: string;
    messageType: "text" | "image" | "deleted";
    image?: {
      url: string;
      publicId: string;
    };
  };
  isEdited?: boolean;
  editedAt?: Date;
  linkPreview?: ILinkPreview;
}

const schema = new Schema<IMessage>(
  {
    chatId: {
      type: Schema.Types.ObjectId,
      ref: "Chat",
      required: true,
    },
    sender: {
      type: String,
      required: true,
    },
    text: String,
    image: {
      url: String,
      publicId: String,
    },
    messageType: {
      type: String,
      enum: ["text", "image", "deleted", "reply", "forward"],
      default: "text",
    },
    seen: {
      type: Boolean,
      default: false,
    },
    seenAt: {
      type: Date,
      default: null,
    },
    reactions: [
      {
        userId: String,
        emoji: String,
        _id: false,
      },
    ],
    replyTo: {
      type: Schema.Types.ObjectId,
      ref: "Messages",
      default: null,
    },
    forwardedFrom: {
      type: String,
      default: null,
    },
    repliedMessage: {
      _id: {
        type: Schema.Types.ObjectId,
        ref: "Messages",
      },
      text: String,
      sender: String,
      messageType: {
        type: String,
        enum: ["text", "image", "deleted"], // Only these three types allowed
      },
      image: {
        url: String,
        publicId: String,
      },
    },
    isEdited: {
      type: Boolean,
      default: false,
    },
    editedAt: {
      type: Date,
      default: null,
    },
    linkPreview: {
      url: String,
      title: String,
      description: String,
      image: String,
      siteName: String,
      favicon: String,
    },
  },
  {
    timestamps: true,
  }
);

export const Messages = mongoose.model<IMessage>("Messages", schema);
