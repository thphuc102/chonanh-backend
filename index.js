const express = require('express');
const cors = require('cors');
const compression = require('compression');
const { PrismaClient } = require('@prisma/client');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { LRUCache } = require('lru-cache');
const { google } = require('googleapis');
const sharp = require('sharp');
require('dotenv').config();

// CDN Sync utilities (Cloudflare R2 + Supabase Storage)
const { migrateBatchToCDN, getCDNStats } = require('./utils/cdnSync');

// ─── SUPABASE CLIENT (Token Verification & Admin Operations) ───────────────────
const { createClient } = require('@supabase/supabase-js');
const supabaseUrl = process.env.SUPABASE_URL || 'https://fjaamkzodjrhxsnsbzus.supabase.co';
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseServiceRoleKey) {
    console.error("❌ [SUPABASE]: SUPABASE_SERVICE_ROLE_KEY is missing from environment variables!");
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey || '', {
    auth: {
        autoRefreshToken: false,
        persistSession: false
    }
});

console.log("✅ [SUPABASE]: Initialized for URL: " + supabaseUrl);

function loadServiceAccountFromEnvOrFile() {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
        try {
            const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8');
            return JSON.parse(decoded);
        } catch (e) {
            console.error(`Invalid FIREBASE_SERVICE_ACCOUNT_BASE64: ${e.message}`);
            return null;
        }
    }

    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        try {
            return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        } catch (e) {
            console.error(`Invalid FIREBASE_SERVICE_ACCOUNT JSON: ${e.message}`);
            return null;
        }
    }

    const saPath = path.join(__dirname, './service-account.json');
    if (fs.existsSync(saPath)) {
        return require(saPath);
    }

    return null;
}

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const token = authHeader.slice(7);

    try {
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (error || !user) {
            return res.status(401).json({ success: false, error: 'Invalid or expired token', details: error?.message });
        }
        req.user = user;
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

const PHOTO_PAGE_DEFAULT_LIMIT = 50;
const PHOTO_PAGE_MAX_LIMIT = 100;

const DUAL_WRITE_FIRESTORE = false;
const DATA_READ_MODE = 'postgres_only';

function encodePhotoCursor(cursor) {
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodePhotoCursor(rawCursor) {
    try {
        const decoded = Buffer.from(rawCursor, 'base64url').toString('utf8');
        const parsed = JSON.parse(decoded);
        if (!parsed || typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

function extractDriveIdFromUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;

    const lh3Match = rawUrl.match(/googleusercontent\.com\/d\/([a-zA-Z0-9_-]+)/);
    if (lh3Match) return lh3Match[1];

    const fileMatch = rawUrl.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (fileMatch) return fileMatch[1];

    try {
        const parsed = new URL(rawUrl);
        const id = parsed.searchParams.get('id');
        if (id) return id;
    } catch {
        // ignore malformed URLs
    }

    const queryIdMatch = rawUrl.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (queryIdMatch) return queryIdMatch[1];

    return null;
}

function isValidEmail(value) {
    if (!value || typeof value !== 'string') return false;
    const email = value.trim();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Middleware
app.use(compression()); // Gzip compress all responses

// CORS: allow trusted origins + Firebase Hosting domains (web.app/firebaseapp.com)
const staticAllowedOrigins = [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'https://chonanh.thphuc.io.vn',
];

const envAllowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

const allowedOrigins = [...new Set([...staticAllowedOrigins, ...envAllowedOrigins])];

function isAllowedOrigin(origin) {
    if (!origin) return true; // server-to-server/no-origin

    if (allowedOrigins.includes(origin)) return true;

    // Firebase Hosting default domains
    if (/^https:\/\/[a-z0-9-]+\.web\.app$/i.test(origin)) return true;
    if (/^https:\/\/[a-z0-9-]+\.firebaseapp\.com$/i.test(origin)) return true;

    return false;
}

app.use(cors({
    origin: (origin, callback) => {
        if (isAllowedOrigin(origin)) {
            callback(null, true);
        } else {
            console.warn(`[CORS] Blocked origin: ${origin}`);
            callback(new Error(`CORS blocked: origin '${origin}' is not allowed`));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
}));

app.use(express.json({ limit: '50mb' }));

app.use((req, res, next) => {
    const requestId = String(req.headers['x-request-id'] || '').trim() || randomUUID();
    req.requestId = requestId;
    res.set('x-request-id', requestId);
    res.set('x-data-read-mode', DATA_READ_MODE);
    next();
});

// Firestore helper functions removed because Firebase is deprecated.

// Route handlers follow below

// ─── MASTER ADMIN AUTH [SERVER-SIDE VERIFIED] ──────────────────────────────
app.post('/api/auth/master-login', async (req, res) => {
    const { identifier, password } = req.body || {};
    const expectedIdentifier = process.env.MASTER_ADMIN_IDENTIFIER || 'thphuc@chonanh.com';
    const expectedPassword   = process.env.MASTER_ADMIN_PASSWORD;

    if (!expectedIdentifier || !expectedPassword) {
        return res.status(503).json({ success: false, error: 'Master auth not configured on server' });
    }

    const shortName = expectedIdentifier.includes('@') ? expectedIdentifier.split('@')[0] : expectedIdentifier;
    const identifierOk = identifier === expectedIdentifier || identifier === shortName;

    if (!identifierOk || password !== expectedPassword) {
        await new Promise(r => setTimeout(r, 500));
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    try {
        let user = await prisma.user.findUnique({ where: { email: expectedIdentifier } });
        if (!user) {
            let uid;
            try {
                const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
                    email: expectedIdentifier,
                    password: expectedPassword,
                    email_confirm: true,
                    user_metadata: { name: 'SuperAdmin' }
                });

                if (authError) {
                    if (authError.status === 422 || authError.message.includes('already exists')) {
                        const { data: { users } } = await supabase.auth.admin.listUsers();
                        const foundUser = users?.find(u => u.email === expectedIdentifier);
                        uid = foundUser?.id;
                    } else {
                        throw authError;
                    }
                } else if (authUser?.user) {
                    uid = authUser.user.id;
                }
            } catch (e) {
                console.warn('[master-login] Supabase Auth creation failed, attempting lookup:', e.message);
                const { data: { users } } = await supabase.auth.admin.listUsers();
                const foundUser = users?.find(u => u.email === expectedIdentifier);
                uid = foundUser?.id;
            }

            if (!uid) {
                uid = randomUUID();
            }

            user = await prisma.user.create({
                data: {
                    id: uid,
                    name: 'SuperAdmin',
                    email: expectedIdentifier,
                    role: 'SuperAdmin',
                    status: 'Active',
                    plan: 'enterprise',
                    albumsLimit: 9999,
                    storageLimitMB: 102400,
                    createdAt: new Date().toISOString()
                }
            });
        }

        const { data, error } = await supabase.auth.signInWithPassword({
            email: expectedIdentifier,
            password: expectedPassword
        });

        if (error) {
            return res.status(401).json({ success: false, error: 'Auth failed', details: error.message });
        }

        return res.json({ success: true, data: user, session: data.session });

    } catch (e) {
        console.error('[master-login] Error:', e);
        return res.status(500).json({ success: false, error: 'Auth failed', details: e.message });
    }
});

// POST /api/auth/user-login
app.post('/api/auth/user-login', async (req, res) => {
    const { identifier, password } = req.body || {};
    const normalizedIdentifier = String(identifier || '').trim();
    if (!normalizedIdentifier || !String(password || '').trim()) {
        return res.status(400).json({ success: false, error: 'Credentials required' });
    }

    try {
        const dbUser = await prisma.user.findFirst({
            where: {
                OR: [
                    { email: normalizedIdentifier },
                    { name: normalizedIdentifier },
                    { phone: normalizedIdentifier }
                ]
            }
        });

        if (!dbUser) {
            await new Promise(r => setTimeout(r, 400));
            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }

        const { data, error } = await supabase.auth.signInWithPassword({
            email: dbUser.email,
            password: password
        });

        if (error) {
            await new Promise(r => setTimeout(r, 400));
            return res.status(401).json({ success: false, error: 'Invalid credentials', details: error.message });
        }

        return res.json({ success: true, data: dbUser, session: data.session });

    } catch (e) {
        console.error('[user-login] Error:', e);
        return res.status(500).json({ success: false, error: 'Login failed', details: e.message });
    }
});

// ─── USER MANAGEMENT API ─────────────────────────────────────────────────────

app.get('/api/users', requireAuth, async (req, res) => {
    try {
        const requester = await prisma.user.findUnique({ where: { id: req.user.id } });
        if (!requester || (requester.role !== 'Admin' && requester.role !== 'SuperAdmin')) {
            return res.status(403).json({ success: false, error: 'Forbidden' });
        }

        const users = await prisma.user.findMany({
            orderBy: { createdAt: 'desc' }
        });
        return res.json({ success: true, data: users });
    } catch (error) {
        console.error("Error fetching users:", error);
        return res.status(500).json({ success: false, error: "Failed to fetch users" });
    }
});

app.post('/api/users', requireAuth, async (req, res) => {
    try {
        const requester = await prisma.user.findUnique({ where: { id: req.user.id } });
        if (!requester || (requester.role !== 'Admin' && requester.role !== 'SuperAdmin')) {
            return res.status(403).json({ success: false, error: 'Forbidden' });
        }

        const { email, password, name, role, plan, albumsLimit, storageLimitMB, phone } = req.body;
        if (!email || !password || !name) {
            return res.status(400).json({ success: false, error: 'email, password and name are required' });
        }

        const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
            email,
            password,
            email_confirm: true,
            user_metadata: { name }
        });

        if (authError) {
            return res.status(400).json({ success: false, error: 'Failed to create auth user', details: authError.message });
        }

        const uid = authUser.user.id;

        const newUser = await prisma.user.create({
            data: {
                id: uid,
                email,
                name,
                role: role || 'User',
                phone: phone || '',
                plan: plan || 'free',
                albumsLimit: albumsLimit !== undefined ? Number(albumsLimit) : 2,
                storageLimitMB: storageLimitMB !== undefined ? Number(storageLimitMB) : 500,
                status: 'Active',
                createdAt: new Date().toISOString()
            }
        });

        return res.status(201).json({ success: true, data: newUser });
    } catch (error) {
        console.error("Error creating user:", error);
        return res.status(500).json({ success: false, error: "Failed to create user", details: error.message });
    }
});

app.put('/api/users/:id', requireAuth, async (req, res) => {
    try {
        const requester = await prisma.user.findUnique({ where: { id: req.user.id } });
        if (!requester || (requester.role !== 'Admin' && requester.role !== 'SuperAdmin')) {
            return res.status(403).json({ success: false, error: 'Forbidden' });
        }

        const userId = req.params.id;
        const updates = req.body;

        const allowedKeys = [
            'name', 'role', 'status', 'avatar', 'phone', 'plan', 
            'subscriptionStatus', 'subscriptionStart', 'subscriptionEnd', 'subscriptionNotes',
            'albumsLimit', 'storageLimitMB', 'weddingAddOns'
        ];

        const cleanUpdates = {};
        for (const key of allowedKeys) {
            if (updates[key] !== undefined) {
                cleanUpdates[key] = updates[key];
            }
        }

        const authUpdates = {};
        if (updates.email) authUpdates.email = updates.email;
        if (updates.password) authUpdates.password = updates.password;

        if (Object.keys(authUpdates).length > 0) {
            const { error: authError } = await supabase.auth.admin.updateUserById(userId, authUpdates);
            if (authError) {
                return res.status(400).json({ success: false, error: 'Failed to update auth user', details: authError.message });
            }
            if (updates.email) {
                cleanUpdates.email = updates.email;
            }
        }

        const updatedUser = await prisma.user.update({
            where: { id: userId },
            data: cleanUpdates
        });

        return res.json({ success: true, data: updatedUser });
    } catch (error) {
        console.error("Error updating user:", error);
        return res.status(500).json({ success: false, error: "Failed to update user", details: error.message });
    }
});

app.delete('/api/users/:id', requireAuth, async (req, res) => {
    try {
        const requester = await prisma.user.findUnique({ where: { id: req.user.id } });
        if (!requester || (requester.role !== 'Admin' && requester.role !== 'SuperAdmin')) {
            return res.status(403).json({ success: false, error: 'Forbidden' });
        }

        const userId = req.params.id;

        const { error: authError } = await supabase.auth.admin.deleteUser(userId);
        if (authError) {
            console.warn('[user-delete] Supabase Auth deletion warning:', authError.message);
        }

        await prisma.user.delete({
            where: { id: userId }
        });

        return res.json({ success: true, message: 'User deleted successfully' });
    } catch (error) {
        console.error("Error deleting user:", error);
        return res.status(500).json({ success: false, error: "Failed to delete user", details: error.message });
    }
});

// ─── RSVP API ────────────────────────────────────────────────────────────────

app.post('/api/albums/:albumId/rsvp', guestRateLimiter, async (req, res) => {
    try {
        const { name, phone, attending, guestsCount, note } = req.body;
        const albumId = req.params.albumId;

        if (!name || !phone || attending === undefined) {
            return res.status(400).json({ success: false, error: 'name, phone and attending status are required' });
        }

        const rsvp = await prisma.rSVP.create({
            data: {
                albumId,
                name,
                phone,
                attending: Boolean(attending),
                guestsCount: guestsCount !== undefined ? Number(guestsCount) : 0,
                note: note || ''
            }
        });

        return res.status(201).json({ success: true, data: rsvp });
    } catch (error) {
        console.error("Error creating RSVP:", error);
        return res.status(500).json({ success: false, error: "Failed to submit RSVP", details: error.message });
    }
});

app.get('/api/albums/:albumId/rsvp', requireAuth, async (req, res) => {
    try {
        const albumId = req.params.albumId;

        const album = await prisma.album.findUnique({
            where: { id: albumId }
        });
        if (!album) {
            return res.status(404).json({ success: false, error: 'Album not found' });
        }

        const requester = await prisma.user.findUnique({ where: { id: req.user.id } });
        const isOwner = album.creatorId === req.user.id;
        const isAdmin = requester && (requester.role === 'Admin' || requester.role === 'SuperAdmin');

        if (!isOwner && !isAdmin) {
            return res.status(403).json({ success: false, error: 'Forbidden' });
        }

        const rsvps = await prisma.rSVP.findMany({
            where: { albumId },
            orderBy: { createdAt: 'desc' }
        });

        return res.json({ success: true, data: rsvps });
    } catch (error) {
        console.error("Error fetching RSVPs:", error);
        return res.status(500).json({ success: false, error: "Failed to fetch RSVPs" });
    }
});

app.delete('/api/albums/:albumId/rsvp/:id', requireAuth, async (req, res) => {
    try {
        const { albumId, id } = req.params;

        const album = await prisma.album.findUnique({
            where: { id: albumId }
        });
        if (!album) {
            return res.status(404).json({ success: false, error: 'Album not found' });
        }

        const requester = await prisma.user.findUnique({ where: { id: req.user.id } });
        const isOwner = album.creatorId === req.user.id;
        const isAdmin = requester && (requester.role === 'Admin' || requester.role === 'SuperAdmin');

        if (!isOwner && !isAdmin) {
            return res.status(403).json({ success: false, error: 'Forbidden' });
        }

        await prisma.rSVP.delete({
            where: { id }
        });

        return res.json({ success: true, message: 'RSVP deleted successfully' });
    } catch (error) {
        console.error("Error deleting RSVP:", error);
        return res.status(500).json({ success: false, error: "Failed to delete RSVP" });
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

function buildAtomicCommentPayload(req) {
    const body = req.body || {};
    const rawContent = typeof body.content === 'string' ? body.content : (typeof body.text === 'string' ? body.text : '');
    const content = rawContent.trim();
    if (!content) {
        return { error: 'Nội dung bình luận không được trống' };
    }
    if (content.length > 500) {
        return { error: 'Bình luận quá dài (tối đa 500 ký tự)' };
    }

    const userName = String(body.userName || body.guestName || 'Khách').trim().slice(0, 80) || 'Khách';
    const role = ['Admin', 'User', 'Customer'].includes(body.role) ? body.role : 'Customer';

    const comment = {
        id: randomUUID(),
        userId: body.userId ? String(body.userId).slice(0, 120) : undefined,
        userName,
        userAvatar: body.userAvatar ? String(body.userAvatar).slice(0, 2000) : '',
        content,
        createdAt: new Date().toISOString(),
        role,
        attachmentUrl: body.attachmentUrl ? String(body.attachmentUrl).slice(0, 2000) : undefined,
        audioUrl: body.audioUrl ? String(body.audioUrl).slice(0, 2000) : undefined,
        audioDuration: Number.isFinite(Number(body.audioDuration)) ? Number(body.audioDuration) : undefined,
    };

    return { comment };
}

async function appendCommentAtomic(photoId, comment) {
    const rows = await prisma.$queryRaw`
        UPDATE "Photo"
        SET
            "comments"     = COALESCE("comments", '[]'::jsonb) || ${JSON.stringify([comment])}::jsonb,
            "commentCount" = COALESCE("commentCount", 0) + 1
        WHERE "id" = ${photoId}
        RETURNING "commentCount"
    `;
    return rows;
}

// W-01: Atomic comment append — PostgreSQL jsonb || operator, no GET-modify-PUT pattern
async function handleAddComment(req, res) {
    try {
        const built = buildAtomicCommentPayload(req);
        if (built.error) {
            return res.status(400).json({ success: false, error: built.error });
        }

        const rows = await appendCommentAtomic(req.params.id, built.comment);
        if (!rows || rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Photo not found' });
        }

        res.status(201).json({ success: true, comment: built.comment, commentCount: Number(rows[0].commentCount) });
    } catch (error) {
        console.error('Error adding comment:', error);
        res.status(500).json({ success: false, error: 'Failed to add comment' });
    }
}

async function handleDeleteComment(req, res) {
    try {
        const photoId = req.params.id;
        const commentId = String(req.params.commentId || '').trim();

        if (!commentId) {
            return res.status(400).json({ success: false, error: 'commentId is required' });
        }

        const result = await prisma.$transaction(async (tx) => {
            const rows = await tx.$queryRaw`
                SELECT "comments"
                FROM "Photo"
                WHERE "id" = ${photoId}
                FOR UPDATE
            `;

            if (!rows || rows.length === 0) {
                return { notFound: true };
            }

            const currentComments = Array.isArray(rows[0].comments) ? rows[0].comments : [];
            const nextComments = currentComments.filter((c) => c && String(c.id) !== commentId);

            if (nextComments.length === currentComments.length) {
                return { notFoundComment: true };
            }

            const updated = await tx.photo.update({
                where: { id: photoId },
                data: {
                    comments: nextComments,
                    commentCount: nextComments.length,
                },
                select: { commentCount: true },
            });

            return { updated };
        });

        if (result.notFound) {
            return res.status(404).json({ success: false, error: 'Photo not found' });
        }
        if (result.notFoundComment) {
            return res.status(404).json({ success: false, error: 'Comment not found' });
        }

        return res.json({
            success: true,
            deletedCommentId: commentId,
            commentCount: Number(result.updated.commentCount),
        });
    } catch (error) {
        console.error('Error deleting comment:', error);
        return res.status(500).json({ success: false, error: 'Failed to delete comment' });
    }
}

// POST — kept for backward compatibility
app.post('/api/photos/:id/comment', guestRateLimiter, handleAddComment);
// PATCH — new semantic endpoint (W-01)
app.patch('/api/photos/:id/comment', guestRateLimiter, handleAddComment);
// POST — atomic create comment endpoint (Sprint 1)
app.post('/api/photos/:id/comments', guestRateLimiter, handleAddComment);
// DELETE — atomic delete comment endpoint (Sprint 1)
app.delete('/api/photos/:id/comments/:commentId', guestRateLimiter, handleDeleteComment);

// GET /api/albums/:albumId/guestbook — Public guestbook feed
app.get('/api/albums/:albumId/guestbook', async (req, res) => {
    try {
        const rows = await prisma.guestbookEntry.findMany({
            where: { albumId: req.params.albumId },
            orderBy: { createdAt: 'desc' },
            take: 50,
        });

        const data = rows.map((row) => ({
            ...row,
            createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
        }));

        return res.json({ success: true, data });
    } catch (error) {
        console.error('Error fetching guestbook entries:', error);
        return res.status(500).json({ success: false, error: 'Failed to fetch guestbook entries' });
    }
});

// POST /api/albums/:albumId/guestbook — Public submit guestbook entry
app.post('/api/albums/:albumId/guestbook', guestRateLimiter, async (req, res) => {
    try {
        const senderName = String(req.body?.senderName || '').trim().slice(0, 120);
        const message = String(req.body?.message || '').trim().slice(0, 1000);
        const stickerUrl = req.body?.stickerUrl ? String(req.body.stickerUrl).slice(0, 50) : null;
        const isPrivate = Boolean(req.body?.isPrivate);

        if (!senderName || !message) {
            return res.status(400).json({ success: false, error: 'senderName and message are required' });
        }

        const id = randomUUID();

        const createdRow = await prisma.guestbookEntry.create({
            data: {
                id,
                albumId: req.params.albumId,
                senderName,
                message,
                stickerUrl,
                isPrivate,
            },
        });

        const created = {
            ...createdRow,
            createdAt: createdRow.createdAt instanceof Date ? createdRow.createdAt.toISOString() : createdRow.createdAt,
        };

        return res.status(201).json({ success: true, data: created });
    } catch (error) {
        console.error('Error creating guestbook entry:', error);
        return res.status(500).json({ success: false, error: 'Failed to create guestbook entry' });
    }
});

// POST /api/contact-requests — Ai cũng có thể gửi liên hệ (Guest, rate-limited)
// NOTE: Route này được giữ public nhưng di chuyển lên đây để rõ ràng hơn.

// ─── GOOGLE DRIVE SYNC & PROXY ENDPOINTS ───────────────────────────────────────

/** Fetch ALL image files in a Google Drive folder, handling pagination automatically */
async function listFilesInFolder(driveClient, folderId) {
    let allFiles = [];
    let pageToken = null;
    let pageCount = 0;
    do {
        pageCount++;
        const res = await driveClient.files.list({
            q: `'${folderId}' in parents and mimeType contains 'image/' and trashed = false`,
            fields: "nextPageToken, files(id, name, thumbnailLink, createdTime, webContentLink)",
            pageSize: 1000,
            pageToken: pageToken || undefined,
        });
        if (res.data.files) {
            allFiles = allFiles.concat(res.data.files);
        }
        pageToken = res.data.nextPageToken;
    } while (pageToken);
    return allFiles;
}

/** Helper to generate Google Drive image URL */
const getImageUrl = (file) => {
    if (file.thumbnailLink) {
        return file.thumbnailLink.replace("=s220", "=s2000");
    }
    if (file.webContentLink) {
        return file.webContentLink;
    }
    if (file.id) {
        return `https://drive.google.com/thumbnail?id=${file.id}&sz=w2000`;
    }
    return null;
};

/** Authenticated Google Drive sync endpoint */
app.post('/api/albums/sync-drive', requireAuth, async (req, res) => {
    const { driveLink, downloadDriveLink, finalDriveLink } = req.body;

    if (!driveLink) {
        return res.status(400).json({ success: false, error: 'driveLink is required' });
    }

    try {
        const parsedServiceAccount = loadServiceAccountFromEnvOrFile();
        if (!parsedServiceAccount) {
            console.error('[sync-drive] No service account credentials found.');
            return res.status(500).json({ success: false, error: 'Google Drive authentication not configured' });
        }

        const driveAuth = new google.auth.GoogleAuth({
            credentials: {
                client_email: parsedServiceAccount.client_email,
                private_key: parsedServiceAccount.private_key,
            },
            scopes: ['https://www.googleapis.com/auth/drive.readonly'],
        });
        const driveClient = google.drive({ version: 'v3', auth: driveAuth });

        const folderId = extractDriveIdFromUrl(driveLink);
        const downloadFolderId = downloadDriveLink ? extractDriveIdFromUrl(downloadDriveLink) : null;
        const finalFolderId = finalDriveLink ? extractDriveIdFromUrl(finalDriveLink) : null;

        if (!folderId) {
            return res.status(400).json({ success: false, error: 'Invalid Google Drive Link' });
        }

        const originalFiles = await listFilesInFolder(driveClient, folderId);
        let downloadFiles = [];
        let finalFiles = [];

        if (downloadFolderId) {
            try {
                downloadFiles = await listFilesInFolder(driveClient, downloadFolderId);
            } catch (e) {
                console.error('[sync-drive] Error listing download folder:', e.message);
            }
        }

        if (finalFolderId) {
            try {
                finalFiles = await listFilesInFolder(driveClient, finalFolderId);
            } catch (e) {
                console.error('[sync-drive] Error listing final folder:', e.message);
            }
        }

        const downloadMap = new Map();
        downloadFiles.forEach((f) => {
            downloadMap.set(f.name, f.webContentLink);
        });

        const processedPhotos = originalFiles.map((file) => {
            const imageUrl = getImageUrl(file);
            return {
                id: file.id,
                name: file.name,
                url: imageUrl,
                thumbnailLink: file.thumbnailLink,
                isFavorite: false,
                commentCount: 0,
                source: "drive",
                createdAt: file.createdTime,
                downloadUrl: downloadMap.get(file.name) || null,
            };
        });

        const processedFinalPhotos = finalFiles.map((file) => {
            const imageUrl = getImageUrl(file);
            return {
                id: file.id,
                name: file.name,
                url: imageUrl,
                thumbnailLink: file.thumbnailLink,
                isFavorite: false,
                commentCount: 0,
                source: "final",
                isInWeddingView: true,
                createdAt: file.createdTime,
                downloadUrl: file.webContentLink || null,
            };
        });

        const allPhotos = [...processedPhotos, ...processedFinalPhotos];

        return res.json({
            success: true,
            photos: allPhotos,
            count: allPhotos.length
        });

    } catch (error) {
        console.error('[sync-drive] Sync failed:', error);
        return res.status(500).json({
            success: false,
            error: error.message || 'Không thể truy cập thư mục Google Drive. Vui lòng kiểm tra lại quyền chia sẻ.'
        });
    }
});

/** Helper to proxy Google Drive image stream, resize using Sharp and return WebP */
async function handleImageProxy(fileId, width, quality, res) {
    try {
        const parsedServiceAccount = loadServiceAccountFromEnvOrFile();
        if (!parsedServiceAccount) {
            console.error('[proxy-img] No credentials found.');
            return res.status(500).send('Google Drive proxy authentication not configured');
        }

        const driveAuth = new google.auth.GoogleAuth({
            credentials: {
                client_email: parsedServiceAccount.client_email,
                private_key: parsedServiceAccount.private_key,
            },
            scopes: ['https://www.googleapis.com/auth/drive.readonly'],
        });
        const driveClient = google.drive({ version: 'v3', auth: driveAuth });

        const response = await driveClient.files.get(
            { fileId, alt: 'media' },
            { responseType: 'stream' }
        );

        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.setHeader('Access-Control-Allow-Origin', '*');

        const shouldOptimize = width && width > 0;

        if (shouldOptimize) {
            res.setHeader('Content-Type', 'image/webp');
            
            const transformer = sharp().resize({
                width,
                withoutEnlargement: true,
                fit: 'inside'
            }).webp({ quality: quality || 80 });

            response.data.on('error', (err) => {
                console.error('[proxy-img] Stream read error:', err.message);
                if (!res.headersSent) res.status(500).send('Stream error');
            });

            transformer.on('error', (err) => {
                console.error('[proxy-img] Sharp error:', err.message);
                if (!res.headersSent) {
                    res.setHeader('Content-Type', 'image/jpeg');
                    response.data.pipe(res);
                }
            });

            response.data.pipe(transformer).pipe(res);
        } else {
            res.setHeader('Content-Type', 'image/jpeg');
            response.data.pipe(res);
        }
    } catch (error) {
        console.error(`[proxy-img] Error proxying file ${fileId}:`, error.message);
        if (!res.headersSent) {
            res.status(500).send('Internal Server Error or File Not Found');
        }
    }
}

/** GET /api/img/:id — Proxy image from Google Drive file ID */
app.get('/api/img/:id', async (req, res) => {
    const fileId = req.params.id;
    const wStr = req.query.w || req.query.width;
    const qStr = req.query.q || req.query.quality;

    const width = wStr ? parseInt(wStr, 10) : null;
    const quality = qStr ? parseInt(qStr, 10) : 80;

    await handleImageProxy(fileId, width, quality, res);
});

/** GET /api/proxy-url — Proxy image from direct Google Drive URL */
app.get('/api/proxy-url', async (req, res) => {
    const rawParam = req.query.url;
    if (!rawParam) {
        return res.status(400).send('Missing url param');
    }

    let targetUrl = rawParam;
    try {
        if (targetUrl.startsWith('http%')) targetUrl = decodeURIComponent(targetUrl);
    } catch (e) { /* ignore */ }

    const driveId = extractDriveIdFromUrl(targetUrl);
    if (!driveId) {
        return res.status(400).send('Invalid or non-Drive URL');
    }

    const wStr = req.query.w || req.query.width;
    const qStr = req.query.q || req.query.quality;

    const width = wStr ? parseInt(wStr, 10) : null;
    const quality = qStr ? parseInt(qStr, 10) : 80;

    await handleImageProxy(driveId, width, quality, res);
});


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

// Public guest endpoint — fetch album by ID or custom domain (for shared links)
app.get('/api/guest/album/:identifier', async (req, res) => {
    try {
        const { identifier } = req.params;
        
        let album = await prisma.album.findUnique({
            where: { id: identifier }
        });
        
        if (!album) {
            album = await prisma.album.findFirst({
                where: { domain: identifier }
            });
        }
        
        if (!album) {
            return res.status(404).json({ success: false, error: "Album not found" });
        }
        
        res.json({ 
            success: true, 
            data: {
                id: album.id,
                title: album.title,
                description: album.description,
                coverImage: album.coverImage,
                createdAt: album.createdAt,
                domain: album.domain,
                finalDriveLink: album.finalDriveLink,
                settings: album.settings,
                status: album.status,
            }
        });
    } catch (error) {
        console.error("Error fetching guest album:", error);
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

        const cleanUpdates = {};
        for (const key of allowedAlbumKeys) {
            if (updates[key] !== undefined) {
                cleanUpdates[key] = updates[key];
            }
        }

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
        const albumId = req.params.id;
        await prisma.album.delete({
            where: { id: albumId }
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
        const rawLimit = Number(req.query.limit);
        const limit = Number.isFinite(rawLimit)
            ? Math.min(Math.max(Math.floor(rawLimit), 1), PHOTO_PAGE_MAX_LIMIT)
            : PHOTO_PAGE_DEFAULT_LIMIT;

        let cursor = null;
        if (typeof req.query.cursor === 'string' && req.query.cursor.trim().length > 0) {
            cursor = decodePhotoCursor(req.query.cursor);
            if (!cursor) {
                return res.status(400).json({ success: false, error: 'Invalid cursor' });
            }
        }

        const photos = await prisma.photo.findMany({
            where: {
                albumId: req.params.albumId,
                ...(cursor
                    ? {
                        OR: [
                            { createdAt: { lt: cursor.createdAt } },
                            { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                        ],
                    }
                    : {}),
            },
            orderBy: [
                { createdAt: 'desc' },
                { id: 'desc' },
            ],
            take: limit + 1,
        });

        const hasMore = photos.length > limit;
        const rawData = hasMore ? photos.slice(0, limit) : photos;
        const data = rawData.map((photo) => {
            const sourceUrl = photo.url || photo.thumbnailLink || '';
            const driveId = extractDriveIdFromUrl(sourceUrl);
            return {
                ...photo,
                driveId,
                rawUrl: photo.url || null,
            };
        });
        const last = data[data.length - 1];
        const nextCursor = hasMore && last
            ? encodePhotoCursor({ createdAt: last.createdAt || '', id: last.id })
            : null;

        res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
        res.json({
            success: true,
            count: data.length,
            data,
            pagination: {
                limit,
                hasMore,
                nextCursor,
            },
            nextCursor,
        });
    } catch (error) {
        console.error("Error fetching photos:", error);
        res.status(500).json({ success: false, error: "Failed to fetch photos" });
    }
});

// Batch add photos [PROTECTED]
app.post('/api/albums/:albumId/photos', requireAuth, async (req, res) => {
    try {
        const { photos } = req.body;
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
        delete cleanUpdates.albumId;

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
        const { updates } = req.body;
        if (!updates || !Array.isArray(updates)) {
            return res.status(400).json({ success: false, error: "Invalid updates format" });
        }

        const allowedPhotoKeys = [
            'name', 'url', 'thumbnailLink', 'downloadUrl', 'isInWeddingView',
            'isFavorite', 'isSuggested', 'commentCount', 'comments', 'tags', 'source',
            'likes', 'likeCount'
        ];

        // W-07: Chunk into 100-item batches to avoid locking the DB on large payloads
        const CHUNK_SIZE = 100;
        let totalCount = 0;
        const chunkErrors = [];

        for (let i = 0; i < updates.length; i += CHUNK_SIZE) {
            const chunk = updates.slice(i, i + CHUNK_SIZE);
            try {
                const results = await prisma.$transaction(
                    chunk.map(u => {
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
                totalCount += results.length;
            } catch (chunkError) {
                const chunkIdx = Math.floor(i / CHUNK_SIZE) + 1;
                console.error(`Batch update chunk ${chunkIdx} (items ${i}-${i + chunk.length - 1}) failed:`, chunkError);
                chunkErrors.push({
                    chunkStart: i,
                    chunkEnd: i + chunk.length - 1,
                    error: chunkError.message
                });
            }
        }

        if (chunkErrors.length > 0) {
            return res.status(207).json({
                success: false,
                count: totalCount,
                errors: chunkErrors,
                message: `${totalCount} updated, ${chunkErrors.length} chunk(s) failed`
            });
        }

        res.json({ success: true, count: totalCount });
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

// Public bulk state endpoint for near-realtime cross-client sync (likes/comments/favorite/tags)
app.post('/api/photos/state', async (req, res) => {
    try {
        const rawIds = Array.isArray(req.body?.ids) ? req.body.ids : [];
        const ids = rawIds
            .map((id) => String(id || '').trim())
            .filter(Boolean)
            .slice(0, 500);

        if (!ids.length) {
            return res.json({ success: true, data: [] });
        }

        const rows = await prisma.photo.findMany({
            where: { id: { in: ids } },
            select: {
                id: true,
                albumId: true,
                isFavorite: true,
                likes: true,
                likeCount: true,
                comments: true,
                commentCount: true,
                tags: true,
            }
        });

        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('Error fetching photo state:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch photo state' });
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
    return res.status(410).json({
        success: false,
        error: 'Endpoint deprecated. Use direct Cloudflare Worker URL.',
    });
});

// GET /api/proxy-image/:photoId — Proxy by photo ID (looks up URL from DB)
app.get('/api/proxy-image/:photoId', async (req, res) => {
    return res.status(410).json({
        success: false,
        error: 'Endpoint deprecated. Use direct Cloudflare Worker URL.',
    });
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

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`✅ Server đang chạy tại cổng ${PORT}`);
        console.log(`🌐 Truy cập: http://localhost:${PORT}`);

        const RENDER_URL = process.env.RENDER_EXTERNAL_URL || `https://chonanh-backend.onrender.com`;
        const PING_INTERVAL = 12 * 60 * 1000;

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
}

module.exports = app;
