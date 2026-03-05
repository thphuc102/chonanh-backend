const express = require('express');
const cors = require('cors');
const compression = require('compression');
const { PrismaClient } = require('@prisma/client');
require('dotenv').config();

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(compression()); // Gzip compress all responses
app.use(cors());
app.use(express.json({ limit: '50mb' }));

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

        const allowedKeys = [
            'id', 'title', 'customerName', 'customerEmail', 'customerPhone', 'coverImage',
            'imageCount', 'size', 'status', 'date', 'creator', 'creatorId', 'creatorEmail',
            'domain', 'driveLink', 'downloadDriveLink', 'finalDriveLink', 'tags', 'shootDate',
            'shootLocation', 'password', 'expiryDate', 'landingCover', 'landingAvatar',
            'landingFooter', 'selectionStatus', 'selectionLockedAt', 'priceLink', 'zaloLink',
            'totalViews', 'maxSelections', 'createdAt', 'settings'
        ];

        const cleanData = {};
        for (const key of allowedKeys) {
            if (albumData[key] !== undefined && albumData[key] !== null) {
                cleanData[key] = albumData[key];
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
        if (error.code === 'P2002') {
            return res.status(200).json({ success: true, message: "Album already exists" });
        }
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

        const allowedAlbumKeys = [
            'title', 'customerName', 'customerEmail', 'customerPhone', 'coverImage',
            'imageCount', 'size', 'status', 'date', 'creator', 'creatorId', 'creatorEmail',
            'domain', 'driveLink', 'downloadDriveLink', 'finalDriveLink', 'tags', 'shootDate',
            'shootLocation', 'password', 'expiryDate', 'landingCover', 'landingAvatar',
            'landingFooter', 'selectionStatus', 'selectionLockedAt', 'priceLink', 'zaloLink',
            'totalViews', 'maxSelections', 'createdAt', 'settings'
        ];

        // Clean up undefined/null values and unknown fields
        const cleanUpdates = {};
        for (const key of allowedAlbumKeys) {
            if (updates[key] !== undefined) {
                cleanUpdates[key] = updates[key];
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

// --- PHOTOS API ---

// Get photos by album
app.get('/api/albums/:albumId/photos', async (req, res) => {
    try {
        const photos = await prisma.photo.findMany({
            where: { albumId: req.params.albumId },
            orderBy: { createdAt: 'desc' }
        });
        // Cache for 30 seconds on client to reduce repeated fetches
        res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
        res.json({ success: true, count: photos.length, data: photos });
    } catch (error) {
        console.error("Error fetching photos:", error);
        res.status(500).json({ success: false, error: "Failed to fetch photos" });
    }
});

// Batch add photos
app.post('/api/albums/:albumId/photos', async (req, res) => {
    try {
        const { photos } = req.body; // Array of photo objects
        if (!photos || !Array.isArray(photos) || photos.length === 0) {
            return res.status(400).json({ success: false, error: "No photos provided" });
        }

        const allowedPhotoKeys = [
            'id', 'albumId', 'name', 'url', 'thumbnailLink', 'downloadUrl', 'isInWeddingView',
            'isFavorite', 'isSuggested', 'commentCount', 'comments', 'tags', 'source',
            'createdAt', 'likes', 'likeCount'
        ];

        const albumId = req.params.albumId;
        const cleanPhotos = photos.map(p => {
            const clean = {};
            for (const key of allowedPhotoKeys) {
                if (p[key] !== undefined && p[key] !== null) {
                    clean[key] = p[key];
                }
            }
            clean.albumId = albumId;
            if (!clean.createdAt) clean.createdAt = new Date().toISOString();
            return clean;
        });

        // Use createMany for efficiency, skipDuplicates to avoid errors on re-sync
        const result = await prisma.photo.createMany({
            data: cleanPhotos,
            skipDuplicates: true
        });

        res.status(201).json({ success: true, count: result.count });
    } catch (error) {
        console.error("Error adding photos:", error);
        res.status(500).json({ success: false, error: "Failed to add photos", details: error.message });
    }
});

// Update single photo
app.put('/api/photos/:id', async (req, res) => {
    try {
        const updates = req.body;
        const allowedPhotoKeys = [
            'name', 'url', 'thumbnailLink', 'downloadUrl', 'isInWeddingView',
            'isFavorite', 'isSuggested', 'commentCount', 'comments', 'tags', 'source',
            'likes', 'likeCount'
        ];

        const cleanUpdates = {};
        for (const key of allowedPhotoKeys) {
            if (updates[key] !== undefined) {
                cleanUpdates[key] = updates[key];
            }
        }
        delete cleanUpdates.id;
        delete cleanUpdates.albumId; // Don't allow changing album

        const photo = await prisma.photo.update({
            where: { id: req.params.id },
            data: cleanUpdates
        });
        res.json({ success: true, data: photo });
    } catch (error) {
        console.error("Error updating photo:", error);
        if (error.code === 'P2025') {
            return res.status(404).json({ success: false, error: "Photo not found" });
        }
        res.status(500).json({ success: false, error: "Failed to update photo", details: error.message });
    }
});

// Batch update photos
app.post('/api/photos/batch-update', async (req, res) => {
    try {
        const { updates } = req.body; // Array of { id, data }
        if (!updates || !Array.isArray(updates)) {
            return res.status(400).json({ success: false, error: "Invalid updates format" });
        }

        const allowedPhotoKeys = [
            'name', 'url', 'thumbnailLink', 'downloadUrl', 'isInWeddingView',
            'isFavorite', 'isSuggested', 'commentCount', 'comments', 'tags', 'source',
            'likes', 'likeCount'
        ];

        const results = await prisma.$transaction(
            updates.map(u => {
                const cleanData = {};
                for (const key of allowedPhotoKeys) {
                    if (u.data[key] !== undefined) {
                        cleanData[key] = u.data[key];
                    }
                }
                delete cleanData.id;
                return prisma.photo.update({
                    where: { id: u.id },
                    data: cleanData
                });
            })
        );

        res.json({ success: true, count: results.length });
    } catch (error) {
        console.error("Error batch updating photos:", error);
        res.status(500).json({ success: false, error: "Failed to batch update", details: error.message });
    }
});

// Get single photo
app.get('/api/photos/:id', async (req, res) => {
    try {
        const photo = await prisma.photo.findUnique({ where: { id: req.params.id } });
        if (!photo) return res.status(404).json({ success: false, error: "Photo not found" });
        res.json({ success: true, data: photo });
    } catch (error) {
        res.status(500).json({ success: false, error: "Failed to fetch photo" });
    }
});



// --- AUDIT LOGS API ---

app.get('/api/audit-logs', async (req, res) => {
    try {
        const logs = await prisma.auditLog.findMany({
            orderBy: { timestamp: 'desc' },
            take: 50
        });
        res.json({ success: true, data: logs });
    } catch (error) {
        console.error("Error fetching audit logs:", error);
        res.status(500).json({ success: false, error: "Failed to fetch audit logs" });
    }
});

app.post('/api/audit-logs', async (req, res) => {
    try {
        const logData = req.body;

        const allowedLogKeys = [
            'userId', 'userName', 'action', 'details', 'timestamp', 'ipAddress', 'status'
        ];

        const cleanData = {};
        for (const key of allowedLogKeys) {
            if (logData[key] !== undefined && logData[key] !== null) {
                cleanData[key] = logData[key];
            }
        }

        if (!cleanData.timestamp) cleanData.timestamp = new Date().toISOString();

        const log = await prisma.auditLog.create({
            data: cleanData
        });
        res.status(201).json({ success: true, data: log });
    } catch (error) {
        console.error("Error creating audit log:", error);
        res.status(500).json({ success: false, error: "Failed to create audit log" });
    }
});

// --- NOTIFICATIONS API ---

app.get('/api/notifications', async (req, res) => {
    try {
        const notifications = await prisma.notification.findMany({
            orderBy: { createdAt: 'desc' },
            take: 50
        });
        res.json({ success: true, data: notifications });
    } catch (error) {
        res.status(500).json({ success: false, error: "Failed to fetch notifications" });
    }
});

app.post('/api/notifications', async (req, res) => {
    try {
        const data = req.body;
        if (!data.createdAt) data.createdAt = new Date().toISOString();
        const notification = await prisma.notification.create({ data });
        res.status(201).json({ success: true, data: notification });
    } catch (error) {
        res.status(500).json({ success: false, error: "Failed to create notification" });
    }
});

app.put('/api/notifications/:id', async (req, res) => {
    try {
        const notification = await prisma.notification.update({
            where: { id: req.params.id },
            data: req.body
        });
        res.json({ success: true, data: notification });
    } catch (error) {
        res.status(500).json({ success: false, error: "Failed to update notification" });
    }
});

// --- CONTACT REQUESTS API ---

app.get('/api/contact-requests', async (req, res) => {
    try {
        const requests = await prisma.contactRequest.findMany({
            orderBy: { createdAt: 'desc' }
        });
        res.json({ success: true, data: requests });
    } catch (error) {
        res.status(500).json({ success: false, error: "Failed to fetch contact requests" });
    }
});

app.post('/api/contact-requests', async (req, res) => {
    try {
        const data = req.body;
        if (!data.createdAt) data.createdAt = new Date().toISOString();
        const request = await prisma.contactRequest.create({ data });
        res.status(201).json({ success: true, data: request });
    } catch (error) {
        res.status(500).json({ success: false, error: "Failed to create contact request", details: error.message });
    }
});

app.put('/api/contact-requests/:id', async (req, res) => {
    try {
        const request = await prisma.contactRequest.update({
            where: { id: req.params.id },
            data: req.body
        });
        res.json({ success: true, data: request });
    } catch (error) {
        res.status(500).json({ success: false, error: "Failed to update contact request" });
    }
});

app.delete('/api/contact-requests/:id', async (req, res) => {
    try {
        await prisma.contactRequest.delete({ where: { id: req.params.id } });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: "Failed to delete contact request" });
    }
});

// --- SETTINGS API ---

app.get('/api/settings', async (req, res) => {
    try {
        const setting = await prisma.setting.findUnique({ where: { id: 'global' } });
        res.json({ success: true, data: setting ? setting.data : null });
    } catch (error) {
        console.error("Error fetching settings:", error);
        res.status(500).json({ success: false, error: "Failed to fetch settings" });
    }
});

app.put('/api/settings', async (req, res) => {
    try {
        const data = req.body;
        const setting = await prisma.setting.upsert({
            where: { id: 'global' },
            update: { data },
            create: { id: 'global', data }
        });
        res.json({ success: true, data: setting.data });
    } catch (error) {
        console.error("Error updating settings:", error);
        res.status(500).json({ success: false, error: "Failed to update settings" });
    }
});

// --- WORKSPACES API ---

app.get('/api/workspaces/:userId', async (req, res) => {
    try {
        const workspaces = await prisma.workspace.findMany({
            where: { userId: req.params.userId },
            orderBy: { createdAt: 'asc' }
        });
        res.json({ success: true, data: workspaces });
    } catch (error) {
        console.error("Error fetching workspaces:", error);
        res.status(500).json({ success: false, error: "Failed to fetch workspaces" });
    }
});

app.post('/api/workspaces', async (req, res) => {
    try {
        const workspace = await prisma.workspace.create({ data: req.body });
        res.status(201).json({ success: true, data: workspace });
    } catch (error) {
        console.error("Error creating workspace:", error);
        res.status(500).json({ success: false, error: "Failed to create workspace" });
    }
});

app.put('/api/workspaces/:id', async (req, res) => {
    try {
        const workspace = await prisma.workspace.update({
            where: { id: req.params.id },
            data: req.body
        });
        res.json({ success: true, data: workspace });
    } catch (error) {
        console.error("Error updating workspace:", error);
        res.status(500).json({ success: false, error: "Failed to update workspace" });
    }
});

app.delete('/api/workspaces/:id', async (req, res) => {
    try {
        await prisma.workspace.delete({ where: { id: req.params.id } });
        res.json({ success: true });
    } catch (error) {
        console.error("Error deleting workspace:", error);
        res.status(500).json({ success: false, error: "Failed to delete workspace" });
    }
});

// Start Server
app.listen(PORT, () => {
    console.log(`✅ Server đang chạy tại cổng ${PORT}`);
    console.log(`🌐 Truy cập: http://localhost:${PORT}`);

    // --- KEEP-ALIVE SELF-PING ---
    // Render free tier sleeps after 15 min inactivity.
    // Self-ping every 12 minutes to stay awake (buffer before 15 min timeout).
    const RENDER_URL = process.env.RENDER_EXTERNAL_URL || `https://chonanh-backend.onrender.com`;
    const PING_INTERVAL = 12 * 60 * 1000; // 12 minutes (reduced from 14)

    setInterval(async () => {
        try {
            const res = await fetch(`${RENDER_URL}/`);
            const data = await res.json();
            console.log(`🏓 Keep-alive ping: ${data.message} | ${new Date().toISOString()}`);
        } catch (err) {
            console.error(`❌ Keep-alive ping failed:`, err.message);
        }
    }, PING_INTERVAL);

    console.log(`🏓 Keep-alive ping enabled: every 12 minutes`);
});
