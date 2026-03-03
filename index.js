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

        if (!cleanData.createdAt) {
            cleanData.createdAt = new Date().toISOString();
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

// 3. Get Single Album
app.get('/api/albums/:id', async (req, res) => {
    try {
        const album = await prisma.album.findUnique({
            where: { id: req.params.id }
        });
        if (!album) {
            return res.status(404).json({ success: false, error: "Album not found" });
        }
        res.json({ success: true, data: album });
    } catch (error) {
        console.error("Error fetching album:", error);
        res.status(500).json({ success: false, error: "Failed to fetch album" });
    }
});

// 4. Update Album
app.put('/api/albums/:id', async (req, res) => {
    try {
        const updates = req.body;

        // Clean up undefined/null values
        const cleanUpdates = {};
        for (const [key, value] of Object.entries(updates)) {
            if (value !== undefined) {
                cleanUpdates[key] = value;
            }
        }

        // Don't allow changing the ID
        delete cleanUpdates.id;

        const updatedAlbum = await prisma.album.update({
            where: { id: req.params.id },
            data: cleanUpdates
        });

        res.json({ success: true, data: updatedAlbum });
    } catch (error) {
        console.error("Error updating album:", error);
        if (error.code === 'P2025') {
            return res.status(404).json({ success: false, error: "Album not found" });
        }
        res.status(500).json({ success: false, error: "Failed to update album", details: error.message });
    }
});

// 5. Delete Album
app.delete('/api/albums/:id', async (req, res) => {
    try {
        await prisma.album.delete({
            where: { id: req.params.id }
        });
        res.json({ success: true, message: "Album deleted successfully" });
    } catch (error) {
        console.error("Error deleting album:", error);
        if (error.code === 'P2025') {
            return res.status(404).json({ success: false, error: "Album not found" });
        }
        res.status(500).json({ success: false, error: "Failed to delete album", details: error.message });
    }
});

// Start Server
app.listen(PORT, () => {
    console.log(`✅ Server đang chạy tại cổng ${PORT}`);
    console.log(`🌐 Truy cập: http://localhost:${PORT}`);

    // --- KEEP-ALIVE SELF-PING ---
    // Render free tier sleeps after 15 min inactivity.
    // Self-ping every 14 minutes to stay awake.
    const RENDER_URL = process.env.RENDER_EXTERNAL_URL || `https://chonanh-backend.onrender.com`;
    const PING_INTERVAL = 14 * 60 * 1000; // 14 minutes

    setInterval(async () => {
        try {
            const res = await fetch(`${RENDER_URL}/api/health`);
            const data = await res.json();
            console.log(`🏓 Keep-alive ping: ${data.status} | ${new Date().toISOString()}`);
        } catch (err) {
            console.error(`❌ Keep-alive ping failed:`, err.message);
        }
    }, PING_INTERVAL);

    console.log(`🏓 Keep-alive ping enabled: every 14 minutes`);
});
