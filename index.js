const express = require('express');
const cors = require('cors');
const compression = require('compression');
const { PrismaClient } = require('@prisma/client');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { LRUCache } = require('lru-cache');
require('dotenv').config();

// CDN Sync utilities (Cloudflare R2 + Supabase Storage)
const { migrateBatchToCDN, getCDNStats, isDriveUrl } = require('./utils/cdnSync');

// ─── FIREBASE ADMIN (Token Verification) ─────────────────────────────────────
let firebaseAdmin = null;
try {
    const admin = require('firebase-admin');
    if (!admin.apps.length) {
        let credential;
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            credential = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT));
        } else {
            const saPath = path.join(__dirname, '../functions/service-account.json');
            if (fs.existsSync(saPath)) {
                credential = admin.credential.cert(require(saPath));
            }
        }
        if (credential) {
            admin.initializeApp({
                credential,
                databaseURL: 'https://chonanh-a9d23-default-rtdb.asia-southeast1.firebasedatabase.app',
            });
            firebaseAdmin = admin;
            console.log('[Auth] Firebase Admin initialized ✅');
        } else {
            console.warn('[Auth] No Firebase service account found. Set FIREBASE_SERVICE_ACCOUNT env var.');
        }
    } else {
        firebaseAdmin = admin;
    }
} catch (e) {
    console.warn('[Auth] firebase-admin not available:', e.message);
}

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
    }
    if (!firebaseAdmin) {
        console.error('[Auth] Firebase Admin not initialized — rejecting request');
        return res.status(503).json({ success: false, error: 'Auth service unavailable' });
    }
    const token = authHeader.slice(7);
    try {
        req.user = await firebaseAdmin.auth().verifyIdToken(token);
        next();
    } catch (err) {
        return res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }
}

// ─── GUEST RATE LIMITER (chống spam trên public routes) ──────────────────────
const guestHits = new Map(); // ip → { count, resetAt }
const GUEST_LIMIT = 30;       // 30 requests
const GUEST_WINDOW = 60_000;  // per 60 seconds
setInterval(() => {
    const now = Date.now();
    for (const [ip, e] of guestHits) if (now > e.resetAt) guestHits.delete(ip);
}, 5 * 60_000);

function guestRateLimiter(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    const e = guestHits.get(ip);
    if (!e || now > e.resetAt) {
        guestHits.set(ip, { count: 1, resetAt: now + GUEST_WINDOW });
        return next();
    }
    if (e.count >= GUEST_LIMIT) {
        return res.status(429).json({ success: false, error: 'Quá nhiều request. Vui lòng thử lại sau.' });
    }
    e.count++;
    next();
}

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(compression()); // Gzip compress all responses

// CORS: Only allow requests from trusted origins
const allowedOrigins = [
    'http://localhost:5173',
    'https://chonanh.thphuc.io.vn',
];
app.use(cors({
    origin: (origin, callback) => {
        // Allow server-to-server requests (no origin) and whitelisted origins
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error(`CORS blocked: origin '${origin}' is not allowed`));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '50mb' }));

// --- ROUTES ---

// ─── MASTER ADMIN AUTH [SERVER-SIDE VERIFIED] ──────────────────────────────
// Credentials được verify tại server qua env vars — password KHÔNG bao giờ có trong JS bundle.
app.post('/api/auth/master-login', async (req, res) => {
    const { identifier, password } = req.body || {};
    const expectedIdentifier = process.env.MASTER_ADMIN_IDENTIFIER;
    const expectedPassword   = process.env.MASTER_ADMIN_PASSWORD;

    if (!expectedIdentifier || !expectedPassword) {
        return res.status(503).json({ success: false, error: 'Master auth not configured on server' });
    }

    // So sánh email lẫn username (phần trước @)
    const shortName = expectedIdentifier.includes('@') ? expectedIdentifier.split('@')[0] : expectedIdentifier;
    const identifierOk = identifier === expectedIdentifier || identifier === shortName;

    if (!identifierOk || password !== expectedPassword) {
        await new Promise(r => setTimeout(r, 500)); // làm chậm brute-force
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    if (!firebaseAdmin) {
        return res.status(503).json({ success: false, error: 'Auth service unavailable' });
    }

    try {
        const firestoreDb = firebaseAdmin.firestore();
        const displayName  = shortName.charAt(0).toUpperCase() + shortName.slice(1); // 'thphuc' → 'Thphuc'

        let snap = await firestoreDb.collection('users').where('name', '==', 'ThPhuc').limit(1).get();
        if (snap.empty) {
            snap = await firestoreDb.collection('users').where('name', '==', displayName).limit(1).get();
        }
        if (snap.empty) {
            snap = await firestoreDb.collection('users').where('email', '==', expectedIdentifier).limit(1).get();
        }

        if (snap.empty) {
            return res.status(404).json({ success: false, error: 'Master user not found in Firestore' });
        }

        const docSnap    = snap.docs[0];
        const masterAdmin = { ...docSnap.data(), id: docSnap.id, role: 'SuperAdmin' };

        // Persist SuperAdmin role nếu chưa có
        if (docSnap.data().role !== 'SuperAdmin') {
            firestoreDb.collection('users').doc(docSnap.id).update({ role: 'SuperAdmin' })
                .catch(e => console.error('[master-login] Failed to persist role:', e));
        }

        console.log(`[master-login] SuperAdmin authenticated: ${masterAdmin.email || masterAdmin.name}`);
        return res.json({ success: true, data: masterAdmin });
    } catch (e) {
        console.error('[master-login] Firestore error:', e);
        return res.status(500).json({ success: false, error: 'Auth failed' });
    }
});

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

// ─── PUBLIC: Guest Interaction Routes ───────────────────────────────────────

// POST /api/photos/:id/like — Thả tim (Guest, rate-limited)
// Dùng { increment: 1 } để tránh Race Condition / Lost Update khi nhiều user like đồng thời.
app.post('/api/photos/:id/like', guestRateLimiter, async (req, res) => {
    try {
        const updated = await prisma.photo.update({
            where: { id: req.params.id },
            data: { likeCount: { increment: 1 } },
        });
        res.json({ success: true, likeCount: updated.likeCount });
    } catch (error) {
        if (error.code === 'P2025') {
            return res.status(404).json({ success: false, error: 'Photo not found' });
        }
        res.status(500).json({ success: false, error: 'Failed to like photo' });
    }
});

// POST /api/photos/:id/comment — Bình luận (Guest, rate-limited)
app.post('/api/photos/:id/comment', guestRateLimiter, async (req, res) => {
    try {
        const { text, guestName } = req.body;
        if (!text || typeof text !== 'string' || text.trim().length === 0) {
            return res.status(400).json({ success: false, error: 'Nội dung bình luận không được trống' });
        }
        if (text.trim().length > 500) {
            return res.status(400).json({ success: false, error: 'Bình luận quá dài (tối đa 500 ký tự)' });
        }
        const photo = await prisma.photo.findUnique({ where: { id: req.params.id } });
        if (!photo) return res.status(404).json({ success: false, error: 'Photo not found' });
        const existingComments = Array.isArray(photo.comments) ? photo.comments : [];
        const newComment = {
            id: randomUUID(),
            text: text.trim(),
            guestName: guestName ? String(guestName).substring(0, 50).trim() : 'Khách',
            createdAt: new Date().toISOString(),
        };
        const updated = await prisma.photo.update({
            where: { id: req.params.id },
            data: {
                comments: [...existingComments, newComment],
                commentCount: (photo.commentCount || 0) + 1,
            },
        });
        res.status(201).json({ success: true, comment: newComment, commentCount: updated.commentCount });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to add comment' });
    }
});

// POST /api/contact-requests — Ai cũng có thể gửi liên hệ (Guest, rate-limited)
// NOTE: Route này được giữ public nhưng di chuyển lên đây để rõ ràng hơn.

// ─── ALBUMS API ───────────────────────────────────────────────────────────────

// 1. Get All Albums [PROTECTED — chỉ Admin/Studio được lấy toàn bộ danh sách]
// Guest truy cập album cụ thể qua GET /api/albums/:id (vẫn public).
app.get('/api/albums', requireAuth, async (req, res) => {
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

// 2. Create Album [PROTECTED]
app.post('/api/albums', requireAuth, async (req, res) => {
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

// 4. Update Album [PROTECTED]
app.put('/api/albums/:id', requireAuth, async (req, res) => {
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

// 5. Delete Album [PROTECTED]
app.delete('/api/albums/:id', requireAuth, async (req, res) => {
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

// Batch add photos [PROTECTED]
app.post('/api/albums/:albumId/photos', requireAuth, async (req, res) => {
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

// Update single photo [PROTECTED — dùng /like và /comment cho guest]
app.put('/api/photos/:id', requireAuth, async (req, res) => {
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

// Batch update photos [PROTECTED]
app.post('/api/photos/batch-update', requireAuth, async (req, res) => {
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



// ─── AUDIT LOGS API [PROTECTED] ─────────────────────────────────────────────

app.get('/api/audit-logs', requireAuth, async (req, res) => {
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

app.post('/api/audit-logs', requireAuth, async (req, res) => {
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

// ─── NOTIFICATIONS API [PROTECTED] ──────────────────────────────────────────

app.get('/api/notifications', requireAuth, async (req, res) => {
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

app.post('/api/notifications', requireAuth, async (req, res) => {
    try {
        const ALLOWED = ['type', 'title', 'message', 'albumId', 'userId', 'read', 'createdAt'];
        const cleanData = {};
        for (const key of ALLOWED) {
            if (req.body[key] !== undefined && req.body[key] !== null) cleanData[key] = req.body[key];
        }
        if (!cleanData.createdAt) cleanData.createdAt = new Date().toISOString();
        const notification = await prisma.notification.create({ data: cleanData });
        res.status(201).json({ success: true, data: notification });
    } catch (error) {
        res.status(500).json({ success: false, error: "Failed to create notification" });
    }
});

app.put('/api/notifications/:id', requireAuth, async (req, res) => {
    try {
        const ALLOWED = ['type', 'title', 'message', 'albumId', 'userId', 'read'];
        const cleanData = {};
        for (const key of ALLOWED) {
            if (req.body[key] !== undefined) cleanData[key] = req.body[key];
        }
        const notification = await prisma.notification.update({
            where: { id: req.params.id },
            data: cleanData
        });
        res.json({ success: true, data: notification });
    } catch (error) {
        res.status(500).json({ success: false, error: "Failed to update notification" });
    }
});

// ─── CONTACT REQUESTS API ───────────────────────────────────────────────────

// GET — Admin only [PROTECTED]
app.get('/api/contact-requests', requireAuth, async (req, res) => {
    try {
        const requests = await prisma.contactRequest.findMany({
            orderBy: { createdAt: 'desc' }
        });
        res.json({ success: true, data: requests });
    } catch (error) {
        res.status(500).json({ success: false, error: "Failed to fetch contact requests" });
    }
});

// POST — Public (guest gửi yêu cầu liên hệ, rate-limited)
app.post('/api/contact-requests', guestRateLimiter, async (req, res) => {
    try {
        const ALLOWED = [
            'userId', 'userName', 'email', 'phone', 'requestType',
            'message', 'notes', 'planRequested', 'billingCycle',
            'albumId', 'albumName', 'createdAt'
        ];
        const cleanData = {};
        for (const key of ALLOWED) {
            if (req.body[key] !== undefined && req.body[key] !== null) cleanData[key] = req.body[key];
        }
        if (!cleanData.createdAt) cleanData.createdAt = new Date().toISOString();
        const request = await prisma.contactRequest.create({ data: cleanData });
        res.status(201).json({ success: true, data: request });
    } catch (error) {
        res.status(500).json({ success: false, error: "Failed to create contact request", details: error.message });
    }
});

// PUT/DELETE — Admin only [PROTECTED]
app.put('/api/contact-requests/:id', requireAuth, async (req, res) => {
    try {
        const ALLOWED = ['status', 'notes', 'adminNotes', 'contactedAt', 'completedAt', 'respondedAt', 'respondedBy'];
        const cleanData = {};
        for (const key of ALLOWED) {
            if (req.body[key] !== undefined) cleanData[key] = req.body[key];
        }
        const request = await prisma.contactRequest.update({
            where: { id: req.params.id },
            data: cleanData
        });
        res.json({ success: true, data: request });
    } catch (error) {
        res.status(500).json({ success: false, error: "Failed to update contact request" });
    }
});

app.delete('/api/contact-requests/:id', requireAuth, async (req, res) => {
    try {
        await prisma.contactRequest.delete({ where: { id: req.params.id } });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: "Failed to delete contact request" });
    }
});

// ─── SETTINGS API ────────────────────────────────────────────────────────────

// GET — Public (landing page & guests cần đọc settings)
app.get('/api/settings', async (req, res) => {
    try {
        const setting = await prisma.setting.findUnique({ where: { id: 'global' } });
        res.json({ success: true, data: setting ? setting.data : null });
    } catch (error) {
        console.error("Error fetching settings:", error);
        res.status(500).json({ success: false, error: "Failed to fetch settings" });
    }
});

// PUT — Admin only [PROTECTED]
app.put('/api/settings', requireAuth, async (req, res) => {
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

// ─── WORKSPACES API [PROTECTED] ─────────────────────────────────────────────

app.get('/api/workspaces/:userId', requireAuth, async (req, res) => {
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

app.post('/api/workspaces', requireAuth, async (req, res) => {
    try {
        const ALLOWED = ['userId', 'name', 'color', 'createdAt'];
        const cleanData = {};
        for (const key of ALLOWED) {
            if (req.body[key] !== undefined && req.body[key] !== null) cleanData[key] = req.body[key];
        }
        if (!cleanData.createdAt) cleanData.createdAt = new Date().toISOString();
        const workspace = await prisma.workspace.create({ data: cleanData });
        res.status(201).json({ success: true, data: workspace });
    } catch (error) {
        console.error("Error creating workspace:", error);
        res.status(500).json({ success: false, error: "Failed to create workspace" });
    }
});

app.put('/api/workspaces/:id', requireAuth, async (req, res) => {
    try {
        const ALLOWED = ['name', 'color'];
        const cleanData = {};
        for (const key of ALLOWED) {
            if (req.body[key] !== undefined) cleanData[key] = req.body[key];
        }
        const workspace = await prisma.workspace.update({
            where: { id: req.params.id },
            data: cleanData
        });
        res.json({ success: true, data: workspace });
    } catch (error) {
        console.error("Error updating workspace:", error);
        res.status(500).json({ success: false, error: "Failed to update workspace" });
    }
});

app.delete('/api/workspaces/:id', requireAuth, async (req, res) => {
    try {
        await prisma.workspace.delete({ where: { id: req.params.id } });
        res.json({ success: true });
    } catch (error) {
        console.error("Error deleting workspace:", error);
        res.status(500).json({ success: false, error: "Failed to delete workspace" });
    }
});

// ─── IMAGE PROXY (BYPASS CORB) ────────────────────────────────────────────────

// Allowed domains for proxying — prevents SSRF
const PROXY_ALLOWED_HOSTS = [
    'lh3.googleusercontent.com',
    'lh4.googleusercontent.com',
    'lh5.googleusercontent.com',
    'lh6.googleusercontent.com',
    'drive.google.com',
    'docs.google.com',
];

// In-memory image cache — giới hạn CỨNG 200MB để chống OOM trên Render free tier.
// LRUCache tự động evict entry cũ nhất khi vượt maxSize; TTL xử lý hết hạn.
const PROXY_CACHE_TTL = 365 * 24 * 60 * 60 * 1000; // 1 năm
const proxyCache = new LRUCache({
    maxSize: 200 * 1024 * 1024,           // 200MB hard limit (tính theo bytes)
    sizeCalculation: (entry) => entry.buffer.length,
    ttl: PROXY_CACHE_TTL,
    allowStale: false,
});

// Helper: set image response headers
function sendImage(res, buffer, contentType, cacheHit) {
    res.set({
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
        'X-Proxy-Cache': cacheHit ? 'HIT' : 'MISS',
    });
    return res.send(buffer);
}

// Helper: fetch + validate + cache
async function fetchAndCache(cacheKey, url, extraHeaders = {}) {
    const cached = proxyCache.get(cacheKey);
    if (cached) return { ...cached, hit: true };

    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
            'Referer': 'https://drive.google.com/',
            ...extraHeaders,
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
        const err = new Error(`Upstream ${response.status}`);
        err.status = response.status; // giữ nguyên status gốc để caller phân biệt 403 vs 5xx
        throw err;
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    if (contentType.includes('text/html')) {
        const err = new Error('Got HTML instead of image');
        err.status = 422;
        throw err;
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    proxyCache.set(cacheKey, { buffer, contentType });
    return { buffer, contentType, hit: false };
}

// 1x1 transparent PNG — placeholder khi cả 2 nguồn fail
const PLACEHOLDER_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
);

// ─── /api/img/:driveId — Proxy ảnh Google Drive qua drive_id ─────────────────
//
// Thứ tự ưu tiên:
//   1. lh3.googleusercontent.com/d/{id}=s{size}   (nhanh, không cần API key)
//   2. drive.google.com/uc?export=view&id={id}    (fallback khi lh3 bị chặn)
//   3. Placeholder 1×1 PNG                        (khi cả 2 đều fail)
//
// Query: ?size=<px> (default 1600, max 4096)
app.get('/api/img/:driveId', async (req, res) => {
    const rawId = req.params.driveId;

    // Trích xuất driveId thuần túy — chỉ giữ chuỗi alphanumeric/dash/underscore
    // Loại bỏ path rác kiểu "/drive-storage/..." nếu client vô tình truyền cả URL
    const driveId = rawId.replace(/^.*\/([a-zA-Z0-9_-]{10,})(?:[=?].*)?$/, '$1').trim();

    if (!/^[a-zA-Z0-9_-]{10,}$/.test(driveId)) {
        return res.status(400).json({ error: `Invalid driveId: "${rawId}"` });
    }

    const size = Math.min(parseInt(req.query.size) || 1600, 4096);
    const cacheKey = `drive:${driveId}:${size}`;

    console.log(`[img] Fetching driveId="${driveId}" size=${size}`);

    // Attempt 1 — lh3 (nhanh nhất, không cần auth nếu file Public)
    const primaryUrl = `https://lh3.googleusercontent.com/d/${driveId}=s${size}`;
    try {
        const result = await fetchAndCache(cacheKey, primaryUrl);
        console.log(`[img/${driveId}] lh3 ${result.hit ? 'CACHE HIT' : 'OK'}`);
        return sendImage(res, result.buffer, result.contentType, result.hit);
    } catch (err1) {
        console.warn(`[img/${driveId}] lh3 failed (${err1.message}) → trying uc fallback`);
    }

    // Attempt 2 — drive.google.com/uc (chậm hơn, redirect nhiều bước)
    const fallbackUrl = `https://drive.google.com/uc?export=view&id=${driveId}`;
    try {
        const result = await fetchAndCache(cacheKey, fallbackUrl);
        console.log(`[img/${driveId}] uc fallback ${result.hit ? 'CACHE HIT' : 'OK'}`);
        return sendImage(res, result.buffer, result.contentType, result.hit);
    } catch (err2) {
        console.warn(`[img/${driveId}] uc fallback also failed (${err2.message}) → returning placeholder`);
    }

    // Attempt 3 — Placeholder (không crash server, client vẫn nhận được ảnh hợp lệ)
    res.set({
        'Content-Type': 'image/png',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'X-Proxy-Cache': 'PLACEHOLDER',
    });
    return res.send(PLACEHOLDER_PNG);
});


app.get('/api/proxy-image', async (req, res) => {
    const { url } = req.query;
    if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'Missing url parameter' });
    }

    // Validate URL & restrict to allowed domains
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return res.status(400).json({ error: 'Invalid URL' });
    }

    if (!PROXY_ALLOWED_HOSTS.some(h => parsed.hostname === h || parsed.hostname.endsWith('.' + h))) {
        return res.status(403).json({ error: 'Domain not allowed' });
    }

    // Serve from cache if available (LRUCache handles TTL automatically)
    const cached = proxyCache.get(url);
    if (cached) {
        res.set({
            'Content-Type': cached.contentType,
            'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
            'X-Proxy-Cache': 'HIT',
        });
        return res.send(cached.buffer);
    }

    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://drive.google.com/',
            },
            redirect: 'follow',
            signal: AbortSignal.timeout(15_000),
        });

        if (!response.ok) {
            console.warn(`[proxy-image] Upstream ${response.status} for ${url.substring(0, 80)}…`);
            return res.status(502).json({ error: `Upstream returned ${response.status}` });
        }

        const contentType = response.headers.get('content-type') || 'image/jpeg';

        // Block HTML responses (Google login pages, error pages)
        if (contentType.includes('text/html')) {
            console.warn(`[proxy-image] Got HTML instead of image for ${url.substring(0, 80)}…`);
            return res.status(502).json({ error: 'Upstream returned HTML, not an image' });
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        proxyCache.set(url, { buffer, contentType });

        res.set({
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
            'X-Proxy-Cache': 'MISS',
        });
        res.send(buffer);
    } catch (error) {
        console.error(`[proxy-image] Error:`, error.message);
        res.status(502).json({ error: 'Proxy fetch failed' });
    }
});

// GET /api/proxy-image/:photoId — Proxy by photo ID (looks up URL from DB)
app.get('/api/proxy-image/:photoId', async (req, res) => {
    try {
        const photo = await prisma.photo.findUnique({
            where: { id: req.params.photoId },
            select: { url: true, thumbnailLink: true },
        });
        if (!photo) return res.status(404).json({ error: 'Photo not found' });

        const imageUrl = photo.thumbnailLink || photo.url;
        if (!imageUrl) return res.status(404).json({ error: 'No URL for photo' });

        // If already a CDN URL, redirect instead of proxying
        if (!isDriveUrl(imageUrl)) {
            return res.redirect(301, imageUrl);
        }

        // Proxy the Google Drive URL
        const response = await fetch(imageUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'image/*',
                'Referer': 'https://drive.google.com/',
            },
            redirect: 'follow',
            signal: AbortSignal.timeout(15_000),
        });

        if (!response.ok) {
            return res.status(502).json({ error: `Upstream returned ${response.status}` });
        }

        const contentType = response.headers.get('content-type') || 'image/jpeg';
        if (contentType.includes('text/html')) {
            return res.status(502).json({ error: 'Image URL returned HTML' });
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        res.set({
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
        });
        res.send(buffer);
    } catch (error) {
        console.error(`[proxy-image/:id] Error:`, error.message);
        res.status(502).json({ error: 'Proxy fetch failed' });
    }
});

// ─── CDN MAINTENANCE ROUTES [PROTECTED — Admin only] ────────────────────────

// GET /api/admin/cdn-status — Thống kê trạng thái migration
app.get('/api/admin/cdn-status', requireAuth, async (req, res) => {
    try {
        const stats = await getCDNStats(prisma);
        res.json({ success: true, data: stats });
    } catch (error) {
        console.error('cdn-status error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/admin/migrate-cdn — Chạy migration batch
// Body: { albumId?: string, limit?: number, concurrency?: number }
//   albumId    — chỉ migrate album cụ thể; bỏ trống = migrate toàn bộ
//   limit      — số ảnh mỗi lần chạy (default 20)
//   concurrency — upload song song (default 3)
app.post('/api/admin/migrate-cdn', requireAuth, async (req, res) => {
    const { albumId, limit = 20, concurrency = 3 } = req.body || {};
    try {
        // Tìm ảnh còn Drive URL (chưa migrate)
        const where = {
            OR: [
                { url: { contains: 'googleusercontent.com' } },
                { url: { contains: 'drive.google.com' } },
            ],
            ...(albumId ? { albumId } : {}),
        };

        const photos = await prisma.photo.findMany({
            where,
            select: { id: true, url: true, name: true, albumId: true },
            take: Math.min(limit, 50), // tối đa 50 mỗi request
            orderBy: { albumId: 'asc' },
        });

        if (photos.length === 0) {
            return res.json({ success: true, message: 'Không còn ảnh cần migrate', processed: 0 });
        }

        console.log(`[CDN] Bắt đầu migrate ${photos.length} ảnh (concurrency=${concurrency})...`);
        const result = await migrateBatchToCDN(prisma, photos, concurrency);
        const stats  = await getCDNStats(prisma);

        res.json({
            success: true,
            processed: photos.length,
            succeeded: result.succeeded,
            failed: result.failed,
            globalStats: stats,
        });
    } catch (error) {
        console.error('migrate-cdn error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────

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
