const dns = require("dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const http = require("http");
const dotenv = require("dotenv");
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
    // Allow requests without an Origin header
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
  console.log("User connected:", socket.id);

  // =================================
  // JOIN CHAT ROOM
  // =================================

  socket.on("joinRoom", (roomId) => {
    if (!roomId) return;

    socket.join(roomId);

    console.log(`${socket.id} joined room: ${roomId}`);
  });

  // =================================
  // USER STARTED TYPING
  // =================================

  socket.on("typing", ({ roomId, username } = {}) => {
    if (!roomId || !username) return;

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

    socket.to(roomId).emit("userStoppedTyping");
  });

  // =================================
  // SEND MESSAGE
  // =================================

  socket.on("send_message", async (data, callback) => {
    try {
      const { sender, receiver, message } = data || {};

      if (
        !mongoose.isValidObjectId(sender) ||
        !mongoose.isValidObjectId(receiver) ||
        !message ||
        typeof message !== "string" ||
        !message.trim()
      ) {
        return callback?.({
          success: false,
          message: "Invalid sender, receiver, or message",
        });
      }

      // Check users
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

      // Save message in MongoDB
      const savedMessage = await Messages.create({
        sender: senderUser._id,
        receiver: receiverUser._id,
        message: message.trim(),
        status: "sent",
      });

      // Generate same room ID for both users
      const roomId = getRoomId(senderUser._id, receiverUser._id);

      // Send message to BOTH users
      io.to(roomId).emit("receive_message", savedMessage);

      io.to(roomId).emit("userStoppedTyping");

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

      io.to(roomId).emit("message_status_update", {
        _id: updatedMessage._id.toString(),
        status: "read",
        deliveredAt: updatedMessage.deliveredAt,
        readAt: updatedMessage.readAt,
      });

      console.log("Message read:", messageId);
    } catch (error) {
      console.error("Read receipt error:", error);
    }
  });

  // =================================
  // DISCONNECT
  // =================================

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);

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

    if (!sender || !receiver) {
      return res.status(400).json({
        success: false,
        message: "Sender and receiver are required",
      });
    }

    if (
      !mongoose.isValidObjectId(sender) ||
      !mongoose.isValidObjectId(receiver)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid sender or receiver ID",
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
    const { currentUser } = req.query;

    if (!currentUser) {
      return res.status(400).json({
        success: false,
        message: "Current username is required",
      });
    }

    const users = await User.find({
      username: { $ne: currentUser },
    }).select("-password");

    return res.status(200).json(users);
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
// START SERVER
// =================================

const PORT = process.env.PORT || 5001;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
