const mongoose = require("mongoose");
const Messages = require("../models/Messages.models");

const getMessages = async (req, res) => {
  try {
    const { receiver } = req.query;
    const sender = req.user.id;

    if (
      !mongoose.Types.ObjectId.isValid(receiver) ||
      !mongoose.Types.ObjectId.isValid(sender)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid user ID",
      });
    }

    const messages = await Messages.find({
      $or: [
        { sender, receiver },
        { sender: receiver, receiver: sender },
      ],
    }).sort({ createdAt: 1 });

    res.status(200).json({
      success: true,
      messages,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch messages",
      error: error.message,
    });
  }
};

module.exports = { getMessages };