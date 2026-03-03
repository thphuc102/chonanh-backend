const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
require('dotenv').config();

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// --- ROUTES ---

// Health Check
app.get('/', (req, res) => {
    res.json({
        success: true,
        message: '🚀 Xin chào! API Backend của ChonAnh đang hoạt động trơn tru.',
        version: '1.0.0',
        timestamp: new Date().toISOString()
    });
});

app.get('/api/health', async (req, res) => {
    try {
        // Optional: Ping database to check connection
        await prisma.$queryRaw`SELECT 1`;
        res.json({ status: 'OK', database: 'connected' });
    } catch (error) {
        console.error("Database connection failed:", error);
        res.status(500).json({ status: 'ERROR', database: 'disconnected', error: error.message });
    }
});

// --- ALBUMS API ---

// 1. Get All Albums
app.get('/api/albums', async (req, res) => {
    try {
        const albums = await prisma.album.findMany({
            orderBy: { createdAt: 'desc' }
        });
        res.json({ success: true, count: albums.length, data: albums });
    } catch (error) {
        console.error("Error fetching albums:", error);
        res.status(500).json({ success: false, error: "Failed to fetch albums" });
    }
});

// 2. Create Album
app.post('/api/albums', async (req, res) => {
    try {
        const albumData = req.body;

        // Clean up undefined/null values that Prisma might reject or shouldn't be overridden
        const cleanData = {};
        for (const [key, value] of Object.entries(albumData)) {
            if (value !== undefined && value !== null) {
                cleanData[key] = value;
            }
        }

        // Ensure ID is completely omitted if not provided so Prisma generates a UUID
        if (!cleanData.id) {
            delete cleanData.id;
        }

        const newAlbum = await prisma.album.create({
            data: cleanData
        });

        res.status(201).json({ success: true, data: newAlbum });
    } catch (error) {
        console.error("Error creating album:", error);
        res.status(500).json({ success: false, error: "Failed to create album", details: error.message });
    }
});

// Start Server
app.listen(PORT, () => {
    console.log(`✅ Server đang chạy tại cổng ${PORT}`);
    console.log(`🌐 Truy cập: http://localhost:${PORT}`);
});
