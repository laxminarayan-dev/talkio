const express = require("express");
const route = express.Router()
const cache = require("../onStart/cache")
const Message = require("../models/Message")
const mongoose = require("mongoose")

route.post("/all", async (req, res) => {
    const limit = 50;
    const { sender, receiver, page } = req.body
    const olderMessages = await Message.find({
        $or: [
            { sender: sender, receiver: receiver },
            { sender: receiver, receiver: sender }
        ]
    })
        .sort({ createdAt: -1 }) // latest first
        .skip(page * limit)       // skip previous pages
        .limit(limit);

    res.send(olderMessages)
})

route.post("/add", async (req, res) => {
    try {
        let { sender,
            receiver,
            senderName,
            senderUsername,
            receiverName,
            receiverUsername,
            replyMessage,
            replyMessageSender,
            replyMessageSenderName,
            content } = req.body;
        if (!sender || !receiver || !content) {
            return res.status(400).json({ error: "Missing required fields" });
        }
        if (!senderName || !senderUsername) {
            const allUsers = cache.get("allUsers") || []
            const senderData = allUsers.find(u => u._id.toString() === sender.toString());

            if (senderData) {
                senderName = senderData.name || "Unknown";
                senderUsername = senderData.username || "unknown";
            }
        }
        const message = new Message({
            sender,
            senderName,
            senderUsername,
            receiver,
            receiverName,
            receiverUsername,
            content,
            replyMessage: replyMessage,
            replyMessageSender: replyMessageSender,
            replyMessageSenderName: replyMessageSenderName,
            type: "text",
        });
        const savedMessage = await message.save();
        res.status(201).json(savedMessage);
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
})


route.post("/lastConversation", async (req, res) => {
    const { userId } = req.body;
    const messages = await Message.aggregate([
        {
            $match: {
                $or: [
                    { sender: new mongoose.Types.ObjectId(userId) },
                    { receiver: new mongoose.Types.ObjectId(userId) }
                ]
            }
        },
        {
            $addFields: {
                otherUser: {
                    $cond: [
                        { $eq: ["$sender", new mongoose.Types.ObjectId(userId)] },
                        "$receiver",
                        "$sender"
                    ]
                }
            }
        },
        {
            $sort: { createdAt: -1 }
        },
        {
            $group: {
                _id: "$otherUser",
                lastMessage: { $first: "$$ROOT" }
            }
        },
        {
            $project: {
                _id: "$lastMessage._id",
                withUser: "$_id",
                message: "$lastMessage.content",
                senderId: "$lastMessage.sender",
                senderName: "$lastMessage.senderName",
                receiverId: "$lastMessage.receiver",
                receiverName: "$lastMessage.receiverName",
                isSeen: "$lastMessage.isSeen",
                createdAt: "$lastMessage.createdAt",
                isOnline: { $literal: false }
            }
        }
    ]);

    const messagesWithOnlineStatus = messages.map(msg => {
        let withUserId = msg.withUser.toString()
        let userInfo = cache.get(`user_${withUserId}`)
        return {
            ...msg, isOnline: userInfo.isOnline
        }
    })

    res.status(200).json(messagesWithOnlineStatus);
})

route.post("/allConversations", async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) {
            return res.status(400).json({ message: "userId is required" });
        }

        const objectId = new mongoose.Types.ObjectId(userId);

        const conversations = await Message.aggregate([
            // 1️⃣ Get only messages where user is sender OR receiver
            {
                $match: {
                    $or: [
                        { sender: objectId },
                        { receiver: objectId },
                    ]
                }
            },

            // 2️⃣ Identify the "other user" per message
            {
                $addFields: {
                    withUser: {
                        $cond: [
                            { $eq: ["$sender", objectId] },
                            "$receiver",
                            "$sender"
                        ]
                    },
                    otherName: {
                        $cond: [
                            { $eq: ["$sender", objectId] },
                            "$receiverName",
                            "$senderName"
                        ]
                    },
                    otherUsername: {
                        $cond: [
                            { $eq: ["$sender", objectId] },
                            "$receiverUsername",
                            "$senderUsername"
                        ]
                    }
                }
            },

            // 3️⃣ Group all messages per conversation partner
            {
                $group: {
                    _id: "$withUser",
                    messages: { $push: "$$ROOT" },
                    lastMessageAt: { $max: "$createdAt" },
                    otherName: { $first: "$otherName" },
                    otherUsername: { $first: "$otherUsername" }
                }
            },

            // 4️⃣ Sort messages DESC so we can slice the latest 60
            {
                $project: {
                    _id: 0,
                    withUser: "$_id",
                    otherName: 1,
                    otherUsername: 1,
                    lastMessageAt: 1,
                    messages: {
                        $slice: [
                            {
                                $filter: {
                                    input: "$messages",
                                    as: "msg",
                                    cond: { $ne: ["$$msg.content", null] }
                                }
                            },
                            -60
                        ]
                    }
                }
            },

            // 5️⃣ Add last message as separate field
            {
                $addFields: {
                    lastMessage: { $arrayElemAt: ["$messages", -1] }
                }
            },

            // 6️⃣ Sort conversation list by the time of last message
            {
                $sort: { lastMessageAt: -1 }
            }
        ]);
        if (conversations.length === 0) {
            return res.status(200).json([]);
        }
        const messagesWithOnlineStatus = conversations.map(conv => {
            let userInfo = cache.get(`user_${conv.withUser}`)
            return {
                ...conv, isOnline: userInfo.isOnline
            }
        })

        res.status(200).json(messagesWithOnlineStatus);
    } catch (error) {
        console.error("Error fetching conversations:", error);
        res.status(500).json({ message: "Server error" });
    }
});





module.exports = route
