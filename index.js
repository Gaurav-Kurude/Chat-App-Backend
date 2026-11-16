const dns = require("dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const http = require("http");
const dotenv = require("dotenv");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");

const authRoutes = require("./routes/auth");
const Messages = require("./models/Messages.models");
const User = require("./models/User.models");

dotenv.config();

const app = express();
const server = http.createServer(app);

// =================================
// ALLOWED FRONTEND ORIGINS
// =================================

const allowedOrigins = [
  "http://localhost:3000",
  "https://chat-app-chi-ten-nz77cs709r.vercel.app",
];

// =================================
// CORS CONFIGURATION
// =================================

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    console.log("Blocked by CORS:", origin);
    return callback(new Error("Not allowed by CORS"));
  },

  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};

// =================================
// SOCKET.IO CONFIGURATION
// =================================

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// =================================
// SOCKET.IO JWT AUTHENTICATION
// =================================

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;

    if (!token) {
      return next(new Error("Authentication token required"));
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (!decoded.id || !mongoose.isValidObjectId(decoded.id)) {
      return next(new Error("Invalid authentication token"));
    }

    socket.data.userId = String(decoded.id);

    next();
  } catch (error) {
    console.error("Socket authentication failed:", error.message);
    next(new Error("Invalid or expired token"));
  }
});

// =================================
// MIDDLEWARE
// =================================

app.use(cors(corsOptions));
app.use(express.json());

// =================================
// DATABASE CONNECTION
// =================================

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB Connected."))
  .catch((error) => console.error("MongoDB Error:", error));

// =================================
// AUTH ROUTES
// =================================

app.use("/auth", authRoutes);

// =================================
// HELPER FUNCTION
// =================================

const getRoomId = (sender, receiver) => {
  return [String(sender), String(receiver)].sort().join("_");
};

// =================================
// SOCKET.IO LOGIC
// =================================

io.on("connection", (socket) => {
  const currentUserId = socket.data.userId;

  console.log("User connected:", currentUserId);

  // =================================
  // JOIN PERSONAL USER ROOM
  // =================================

  const personalRoom = `user_${currentUserId}`;

  socket.join(personalRoom);

  console.log("Joined personal room:", personalRoom);

  // =================================
  // SEND UNREAD COUNTS
  // =================================

  const sendUnreadCounts = async (userId) => {
    try {
      const unreadCounts = await Messages.aggregate([
        {
          $match: {
            receiver: new mongoose.Types.ObjectId(userId),
            status: { $ne: "read" },
          },
        },
        {
          $group: {
            _id: "$sender",
            count: { $sum: 1 },
          },
        },
      ]);

      const counts = {};

      unreadCounts.forEach((item) => {
        counts[item._id.toString()] = item.count;
      });

      io.to(`user_${userId}`).emit("unread_counts", counts);

      return counts;
    } catch (error) {
      console.error("Unread count error:", error);
      return {};
    }
  };

  // =================================
  // GET UNREAD MESSAGE COUNTS
  // =================================

  socket.on("get_unread_counts", async () => {
    await sendUnreadCounts(currentUserId);
  });

  // =================================
  // JOIN CHAT ROOM
  // =================================

  socket.on("joinRoom", (roomId) => {
    if (typeof roomId !== "string") return;

    const participants = roomId.split("_");

    if (
      participants.length !== 2 ||
      !participants.every((id) => mongoose.isValidObjectId(id)) ||
      !participants.includes(String(currentUserId))
    ) {
      return;
    }

    socket.join(roomId);

    socket.data.activeRoom = roomId;

    console.log(`${currentUserId} joined room: ${roomId}`);
  });

  // =================================
  // USER STARTED TYPING
  // =================================

  socket.on("typing", ({ roomId, username } = {}) => {
    if (!roomId || !username) return;

    const participants = roomId.split("_");

    if (!participants.includes(String(currentUserId))) return;

    socket.to(roomId).emit("userTyping", {
      username,
    });

    console.log(`${username} is typing`);
  });

  // =================================
  // USER STOPPED TYPING
  // =================================

  socket.on("stopTyping", ({ roomId } = {}) => {
    if (!roomId) return;

    const participants = roomId.split("_");

    if (!participants.includes(String(currentUserId))) return;

    socket.to(roomId).emit("userStoppedTyping");
  });

  // =================================
  // SEND MESSAGE
  // =================================

  socket.on("send_message", async (data, callback) => {
    try {
      const { receiver, message } = data || {};

      // Sender comes from verified JWT
      const sender = currentUserId;

      if (
        !mongoose.isValidObjectId(receiver) ||
        String(sender) === String(receiver) ||
        typeof message !== "string" ||
        !message.trim()
      ) {
        return callback?.({
          success: false,
          message: "Invalid receiver or message",
        });
      }

      const [senderUser, receiverUser] = await Promise.all([
        User.findById(sender),
        User.findById(receiver),
      ]);

      if (!senderUser || !receiverUser) {
        return callback?.({
          success: false,
          message: "User not found",
        });
      }

      // SAVE MESSAGE
      const savedMessage = await Messages.create({
        sender: senderUser._id,
        receiver: receiverUser._id,
        message: message.trim(),
        status: "sent",
      });

      const roomId = getRoomId(senderUser._id, receiverUser._id);

      // SEND MESSAGE TO CHAT ROOM
      io.to(roomId).emit("receive_message", savedMessage);

      io.to(roomId).emit("userStoppedTyping");

      // UPDATE RECEIVER'S UNREAD COUNT
      await sendUnreadCounts(receiverUser._id);

      console.log("Message successfully saved:", savedMessage._id);
      console.log("Message sent to room:", roomId);

      callback?.({
        success: true,
        message: savedMessage,
      });
    } catch (error) {
      console.error("Message sending error:", error);

      callback?.({
        success: false,
        message: error.message,
      });
    }
  });

  // =================================
  // MESSAGE DELIVERED
  // =================================

  socket.on("message_delivered", async ({ messageId } = {}) => {
    try {
      if (!mongoose.isValidObjectId(messageId)) return;

      const updatedMessage = await Messages.findOneAndUpdate(
        {
          _id: messageId,
          receiver: currentUserId,
          status: "sent",
        },
        {
          $set: {
            status: "delivered",
            deliveredAt: new Date(),
          },
        },
        { new: true },
      );

      if (!updatedMessage) return;

      const roomId = getRoomId(updatedMessage.sender, updatedMessage.receiver);

      io.to(roomId).emit("message_status_update", {
        _id: updatedMessage._id.toString(),
        status: "delivered",
        deliveredAt: updatedMessage.deliveredAt,
      });

      console.log("Message delivered:", messageId);
    } catch (error) {
      console.error("Delivery receipt error:", error);
    }
  });

  // =================================
  // MESSAGE READ
  // =================================

  socket.on("message_read", async ({ messageId } = {}) => {
    try {
      if (!mongoose.isValidObjectId(messageId)) return;

      const updatedMessage = await Messages.findOneAndUpdate(
        {
          _id: messageId,
          receiver: currentUserId,
          status: { $in: ["sent", "delivered"] },
        },
        {
          $set: {
            status: "read",
            readAt: new Date(),
            deliveredAt: new Date(),
          },
        },
        { new: true },
      );

      if (!updatedMessage) return;

      const roomId = getRoomId(updatedMessage.sender, updatedMessage.receiver);

      // UPDATE SENDER'S MESSAGE TICKS
      io.to(roomId).emit("message_status_update", {
        _id: updatedMessage._id.toString(),
        status: "read",
        deliveredAt: updatedMessage.deliveredAt,
        readAt: updatedMessage.readAt,
      });

      // UPDATE RECEIVER'S UNREAD COUNTS
      await sendUnreadCounts(currentUserId);

      console.log("Message read:", messageId);
    } catch (error) {
      console.error("Read receipt error:", error);
    }
  });

  // =================================
  // DISCONNECT
  // =================================

  socket.on("disconnect", () => {
    console.log("User disconnected:", currentUserId);

    if (socket.data.activeRoom) {
      socket.to(socket.data.activeRoom).emit("userStoppedTyping");
    }
  });
});

// =================================
// FETCH MESSAGES
// =================================

app.get("/messages", async (req, res) => {
  try {
    const { sender, receiver } = req.query;

    if (
      !sender ||
      !receiver ||
      !mongoose.isValidObjectId(sender) ||
      !mongoose.isValidObjectId(receiver)
    ) {
      return res.status(400).json({
        success: false,
        message: "Valid sender and receiver IDs are required",
      });
    }

    const messages = await Messages.find({
      $or: [
        { sender, receiver },
        { sender: receiver, receiver: sender },
      ],
    }).sort({ createdAt: 1 });

    return res.status(200).json({
      success: true,
      messages,
    });
  } catch (error) {
    console.error("Error fetching messages:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch messages",
      error: error.message,
    });
  }
});

// =================================
// FETCH USERS
// =================================

app.get("/users", async (req, res) => {
  try {
    const { currentUserId } = req.query;

    if (!currentUserId || !mongoose.isValidObjectId(currentUserId)) {
      return res.status(400).json({
        success: false,
        message: "Valid current user ID is required",
      });
    }

    const users = await User.find({
      _id: { $ne: currentUserId },
    }).select("-password");

    return res.status(200).json({
      success: true,
      users,
    });
  } catch (error) {
    console.error("Fetch users error:", error);

    return res.status(500).json({
      success: false,
      message: "Error fetching users",
      error: error.message,
    });
  }
});

// =================================
// GET UNREAD MESSAGE COUNTS
// =================================

app.get("/unread-counts", async (req, res) => {
  try {
    const { userId } = req.query;

    if (!userId || !mongoose.isValidObjectId(userId)) {
      return res.status(400).json({
        success: false,
        message: "Valid user ID is required",
      });
    }

    const unreadCounts = await Messages.aggregate([
      {
        $match: {
          receiver: new mongoose.Types.ObjectId(userId),
          status: { $ne: "read" },
        },
      },
      {
        $group: {
          _id: "$sender",
          count: { $sum: 1 },
        },
      },
    ]);

    return res.status(200).json({
      success: true,
      unreadCounts,
    });
  } catch (error) {
    console.error("Unread counts error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch unread counts",
    });
  }
});

// =================================
// START SERVER
// =================================

const PORT = process.env.PORT || 5001;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
