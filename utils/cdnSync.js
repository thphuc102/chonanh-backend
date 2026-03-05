/**
 * CDN Sync Orchestrator
 *
 * Uploads photos to Cloudflare R2 (primary) and Supabase Storage (backup)
 * in parallel. Updates the database record with CDN URLs on success.
 *
 * Strategy:
 *   photo.url          → Supabase Storage URL    (primary, same infra as DB)
 *   photo.thumbnailLink → Cloudflare R2 CDN URL  (secondary, fast global delivery, 0 egress)
 *
 * A photo is considered "migrated" when photo.url no longer contains a
 * Google Drive domain (googleusercontent.com / drive.google.com).
 */

const { uploadFromUrlToR2 }       = require('./r2Client');
const { cacheImageToSupabase, isConfigured: supabaseConfigured } = require('./supabaseStorage');

const DRIVE_DOMAINS = ['googleusercontent.com', 'drive.google.com'];
const isDriveUrl = (url) => url && DRIVE_DOMAINS.some(d => url.includes(d));

// ── Single Photo Sync ─────────────────────────────────────────────────────────

/**
 * Upload one photo to R2 + Supabase concurrently.
 * Returns { r2Url, supabaseUrl, error } — never throws.
 *
 * @param {{ id: string, url: string, name: string, albumId: string }} photo
 */
async function syncPhotoToCDN(photo) {
    const sourceUrl = photo.url;
    if (!sourceUrl) return { r2Url: null, supabaseUrl: null, error: 'url trống' };

    const [r2Result, supabaseResult] = await Promise.allSettled([
        uploadFromUrlToR2(sourceUrl, photo.name || `${photo.id}.jpg`, photo.albumId),
        supabaseConfigured()
            ? cacheImageToSupabase(sourceUrl, photo.id, photo.albumId)
            : Promise.reject(new Error('Supabase chưa cấu hình')),
    ]);

    const r2Url          = r2Result.status       === 'fulfilled' ? r2Result.value       : null;
    const supabaseUrl    = supabaseResult.status  === 'fulfilled' ? supabaseResult.value  : null;
    const r2Error        = r2Result.status       === 'rejected'  ? r2Result.reason?.message  : null;
    const supabaseError  = supabaseResult.status  === 'rejected'  ? supabaseResult.reason?.message : null;

    if (r2Error)       console.warn(`[CDN][R2]       ❌ ${photo.id}: ${r2Error}`);
    if (supabaseError) console.warn(`[CDN][Supabase] ❌ ${photo.id}: ${supabaseError}`);

    return { r2Url, supabaseUrl, error: r2Error || supabaseError || null };
}

// ── Batch Migration ───────────────────────────────────────────────────────────

/**
 * Migrate a batch of photos: upload to R2 + Supabase, then update DB.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {Array}  photos       Array of Prisma Photo records
 * @param {number} concurrency  Parallel uploads (default 3)
 * @returns {{ succeeded: number, failed: number, details: Array }}
 */
async function migrateBatchToCDN(prisma, photos, concurrency = 3) {
    const details  = [];
    let succeeded  = 0;
    let failed     = 0;

    for (let i = 0; i < photos.length; i += concurrency) {
        const batch = photos.slice(i, i + concurrency);

        await Promise.all(batch.map(async (photo) => {
            const { r2Url, supabaseUrl, error } = await syncPhotoToCDN(photo);

            if (!r2Url && !supabaseUrl) {
                failed++;
                details.push({ id: photo.id, status: 'failed', error });
                return;
            }

            // Build DB update — only update fields that succeeded
            const dbUpdate = {};
            if (supabaseUrl) dbUpdate.url           = supabaseUrl; // primary: Supabase (same infra as DB)
            if (r2Url)       dbUpdate.thumbnailLink  = r2Url;       // secondary: R2 (fast CDN layer)

            try {
                await prisma.photo.update({ where: { id: photo.id }, data: dbUpdate });
                succeeded++;
                details.push({ id: photo.id, status: 'ok', r2Url, supabaseUrl });
                console.log(`[CDN] ✅ ${photo.id} → R2:${!!r2Url} Supabase:${!!supabaseUrl}`);
            } catch (dbErr) {
                failed++;
                details.push({ id: photo.id, status: 'db_error', error: dbErr.message });
                console.error(`[CDN] ❌ DB update ${photo.id}:`, dbErr.message);
            }
        }));
    }

    return { succeeded, failed, details };
}

// ── Stats ─────────────────────────────────────────────────────────────────────

/**
 * Count how many photos still have Drive URLs vs CDN URLs.
 * @param {import('@prisma/client').PrismaClient} prisma
 */
async function getCDNStats(prisma) {
    const [total, withDriveUrl] = await Promise.all([
        prisma.photo.count(),
        prisma.photo.count({
            where: {
                OR: [
                    { url: { contains: 'googleusercontent.com' } },
                    { url: { contains: 'drive.google.com'      } },
                ]
            }
        }),
    ]);

    const migrated   = total - withDriveUrl;
    const supaCount  = await prisma.photo.count({ where: { url: { contains: 'supabase.co/storage' } } });
    const r2Count    = await prisma.photo.count({ where: { thumbnailLink: { contains: 'r2.dev' } } });

    return {
        total,
        migrated,
        pending: withDriveUrl,
        r2Count,
        supabaseCount: supaCount,
        percentDone: total > 0 ? Math.round((migrated / total) * 100) : 100,
    };
}

module.exports = { syncPhotoToCDN, migrateBatchToCDN, getCDNStats, isDriveUrl };
