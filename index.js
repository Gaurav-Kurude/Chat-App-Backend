const dns = require("dns");

// Local DNS configuration
if (!process.env.VERCEL) {
  dns.setServers(["8.8.8.8", "8.8.4.4"]);
}

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const http = require("http");
const dotenv = require("dotenv");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");

dotenv.config();

const authRoutes = require("./routes/auth");
const Messages = require("./models/Messages.models");
const User = require("./models/User.models");

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

app.use(cors(corsOptions));
app.use(express.json());

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
// DATABASE CONNECTION
// =================================

let connectionPromise;

const connectDB = () => {
  if (mongoose.connection.readyState === 1) {
    return Promise.resolve(mongoose.connection);
  }

  if (!connectionPromise) {
    connectionPromise = mongoose
      .connect(process.env.MONGO_URI, {
        serverSelectionTimeoutMS: 8000,
      })
      .then((connection) => {
        console.log("MongoDB Connected.");
        return connection;
      })
      .catch((error) => {
        connectionPromise = null;
        console.error("MongoDB Error:", error.message);
        throw error;
      });
  }

  return connectionPromise;
};

// Connect to MongoDB before handling API requests
app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (error) {
    res.status(500).json({
      message: "Database connection failed",
      error: error.message,
    });
  }
});

// =================================
// AUTHENTICATION MIDDLEWARE
// =================================

const requireAuth = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Authentication token required",
      });
    }

    const token = authHeader.split(" ")[1];

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    req.userId = String(decoded.id);

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized or invalid token",
    });
  }
};

// =================================
// AUTH ROUTES
// =================================

app.use("/auth", authRoutes);

// =================================
// PRESENCE CONFIGURATION
// =================================

const ONLINE_WINDOW_MS = 60 * 1000;

// =================================
// UPDATE USER LAST SEEN
// =================================

app.post("/presence/heartbeat", requireAuth, async (req, res) => {
  try {
    await User.updateOne(
      { _id: req.userId },
      {
        $set: {
          lastSeen: new Date(),
        },
      },
    );

    return res.status(200).json({
      success: true,
      message: "Heartbeat updated successfully",
    });
  } catch (error) {
    console.error("Heartbeat error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to update heartbeat",
    });
  }
});

// =================================
// GET ALL ONLINE USERS
// =================================

app.get("/presence", requireAuth, async (req, res) => {
  try {
    const since = new Date(Date.now() - ONLINE_WINDOW_MS);

    const onlineUsers = await User.find({
      lastSeen: {
        $gte: since,
      },
    }).select("_id");

    return res.status(200).json({
      success: true,
      onlineUserIds: onlineUsers.map((user) => String(user._id)),
    });
  } catch (error) {
    console.error("Get presence error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch presence",
    });
  }
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
// HELPER FUNCTION
// =================================

const getRoomId = (sender, receiver) => {
  return [String(sender), String(receiver)].sort().join("_");
};

// =================================
// SOCKET.IO JWT AUTHENTICATION
// =================================

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;

  if (!token) {
    console.log("Socket authentication failed: Missing token");
    return next(new Error("Authentication token required"));
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    socket.data.userId = String(decoded.id);

    next();
  } catch (error) {
    console.error("Socket authentication error:", error.message);
    next(new Error("Invalid token"));
  }
});

// =================================
// SOCKET.IO LOGIC
// =================================

io.on("connection", (socket) => {
  const currentUserId = String(socket.data.userId);

  console.log("====================================");
  console.log("SOCKET CONNECTED");
  console.log("User ID:", currentUserId);
  console.log("Socket ID:", socket.id);
  console.log("====================================");

  // =================================
  // JOIN PERSONAL USER ROOM
  // =================================

  const personalRoom = `user_${currentUserId}`;

  socket.join(personalRoom);

  console.log("========== PERSONAL ROOM JOINED ==========");
  console.log("User ID:", currentUserId);
  console.log("Personal Room:", personalRoom);
  console.log("Socket ID:", socket.id);
  console.log("Socket Rooms:", [...socket.rooms]);
  console.log("===========================================");

  // =================================
  // SEND UNREAD COUNTS
  // =================================

  const sendUnreadCounts = async (userId) => {
    try {
      const normalizedUserId = String(userId);

      const unreadCounts = await Messages.aggregate([
        {
          $match: {
            receiver: new mongoose.Types.ObjectId(normalizedUserId),
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

      io.to(`user_${normalizedUserId}`).emit("unread_counts", counts);

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
    if (typeof roomId !== "string") {
      console.log("Invalid room ID received:", roomId);
      return;
    }

    const participants = roomId.split("_");

    if (
      participants.length !== 2 ||
      !participants.every((id) => mongoose.isValidObjectId(id)) ||
      !participants.includes(currentUserId)
    ) {
      console.log("Room join rejected:", {
        userId: currentUserId,
        roomId,
      });
      return;
    }

    socket.join(roomId);
    socket.data.activeRoom = roomId;

    console.log("========== ROOM JOINED SUCCESSFULLY ==========");
    console.log("User ID:", currentUserId);
    console.log("Room ID:", roomId);
    console.log("Socket ID:", socket.id);
    console.log("Socket Rooms:", [...socket.rooms]);
    console.log("===============================================");
  });

  // =================================
  // USER STARTED TYPING
  // =================================

  socket.on("typing", ({ roomId, username } = {}) => {
    if (!roomId || !username) return;

    const participants = roomId.split("_");

    if (!participants.includes(currentUserId)) return;

    socket.to(roomId).emit("userTyping", {
      username,
    });

    console.log(`${username} is typing in room ${roomId}`);
  });

  // =================================
  // USER STOPPED TYPING
  // =================================

  socket.on("stopTyping", ({ roomId } = {}) => {
    if (!roomId) return;

    const participants = roomId.split("_");

    if (!participants.includes(currentUserId)) return;

    socket.to(roomId).emit("userStoppedTyping");
  });

  // =================================
  // SEND MESSAGE
  // =================================

  socket.on("send_message", async (data, callback) => {
    try {
      // Ensure database connection
      await connectDB();

      const { receiver, message } = data || {};

      const sender = currentUserId;

      if (
        !mongoose.isValidObjectId(receiver) ||
        sender === String(receiver) ||
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

      console.log("========== MESSAGE DEBUG ==========");
      console.log("Authenticated sender ID:", sender);
      console.log("Requested receiver ID:", receiver);
      console.log("Sender found:", !!senderUser);
      console.log("Receiver found:", !!receiverUser);
      console.log("===================================");

      if (!senderUser || !receiverUser) {
        return callback?.({
          success: false,
          message: "User not found",
          senderFound: !!senderUser,
          receiverFound: !!receiverUser,
        });
      }

      const savedMessage = await Messages.create({
        sender: senderUser._id,
        receiver: receiverUser._id,
        message: message.trim(),
        status: "sent",
      });

      const senderId = String(senderUser._id);
      const receiverId = String(receiverUser._id);

      const roomId = getRoomId(senderId, receiverId);
      const receiverPersonalRoom = `user_${receiverId}`;

      // =================================
      // CHECK RECEIVER SOCKET CONNECTION
      // =================================

      const receiverSockets = await io.in(receiverPersonalRoom).fetchSockets();

      console.log("========== SENDING MESSAGE ==========");
      console.log("Sender:", senderId);
      console.log("Receiver:", receiverId);
      console.log("Conversation Room:", roomId);
      console.log("Receiver Personal Room:", receiverPersonalRoom);
      console.log("Receiver Connected Sockets:", receiverSockets.length);
      console.log("Saved Message ID:", String(savedMessage._id));
      console.log("=====================================");

      // =================================
      // DELIVER TO RECEIVER PERSONAL ROOM
      // =================================

      io.to(receiverPersonalRoom).emit("receive_message", savedMessage);

      // Stop typing in conversation room
      io.to(roomId).emit("userStoppedTyping");

      // Update receiver unread count
      await sendUnreadCounts(receiverId);

      console.log("Message successfully saved:", savedMessage._id);
      console.log("Message emitted to:", receiverPersonalRoom);

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
      await connectDB();

      if (!mongoose.isValidObjectId(messageId)) {
        console.log("Invalid delivered message ID:", messageId);
        return;
      }

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

      if (!updatedMessage) {
        console.log("Delivery update skipped:", messageId);
        return;
      }

      const senderPersonalRoom = `user_${String(updatedMessage.sender)}`;

      io.to(senderPersonalRoom).emit("message_status_update", {
        _id: String(updatedMessage._id),
        status: "delivered",
        deliveredAt: updatedMessage.deliveredAt,
      });

      console.log("========== MESSAGE DELIVERED ==========");
      console.log("Message ID:", String(updatedMessage._id));
      console.log("Receiver:", currentUserId);
      console.log("Sender Room:", senderPersonalRoom);
      console.log("=======================================");
    } catch (error) {
      console.error("Delivery receipt error:", error);
    }
  });

  // =================================
  // MESSAGE READ
  // =================================

  socket.on("message_read", async ({ messageId } = {}) => {
    try {
      await connectDB();

      if (!mongoose.isValidObjectId(messageId)) {
        console.log("Invalid read message ID:", messageId);
        return;
      }

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

      if (!updatedMessage) {
        console.log("Read update skipped:", messageId);
        return;
      }

      const senderPersonalRoom = `user_${String(updatedMessage.sender)}`;

      io.to(senderPersonalRoom).emit("message_status_update", {
        _id: String(updatedMessage._id),
        status: "read",
        deliveredAt: updatedMessage.deliveredAt,
        readAt: updatedMessage.readAt,
      });

      await sendUnreadCounts(currentUserId);

      console.log("========== MESSAGE READ ==========");
      console.log("Message ID:", String(updatedMessage._id));
      console.log("Reader:", currentUserId);
      console.log("Sender Room:", senderPersonalRoom);
      console.log("==================================");
    } catch (error) {
      console.error("Read receipt error:", error);
    }
  });

  // =================================
  // DISCONNECT
  // =================================

  socket.on("disconnect", (reason) => {
    console.log("========== SOCKET DISCONNECTED ==========");
    console.log("User ID:", currentUserId);
    console.log("Socket ID:", socket.id);
    console.log("Reason:", reason);

    if (socket.data.activeRoom) {
      socket.to(socket.data.activeRoom).emit("userStoppedTyping");
    }

    console.log("==========================================");
  });
});

// =================================
// START SERVER
// =================================

const PORT = process.env.PORT || 5001;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
