/**
 * Supabase Storage Image Cache Utility
 *
 * Downloads images directly from their source URL (Google Drive / R2 / etc.)
 * and caches them in Supabase Storage for permanent CDN delivery.
 *
 * Environment variables required:
 *   SUPABASE_URL              — e.g. https://fjaamkzodjrhxsnsbzus.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY — Server-side key (bypasses RLS)
 */

const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
    console.warn('⚠️  Supabase Storage chưa cấu hình (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY). Image caching tắt.');
}

const supabase = (supabaseUrl && supabaseServiceKey)
    ? createClient(supabaseUrl, supabaseServiceKey, {
        auth: { persistSession: false }
    })
    : null;

const BUCKET_NAME = 'album-photos';

// ── Bucket Initialisation ─────────────────────────────────────────────────────

let bucketReady = false;

async function ensureBucket() {
    if (!supabase || bucketReady) return !!supabase;
    try {
        const { data: buckets } = await supabase.storage.listBuckets();
        const exists = buckets?.some(b => b.name === BUCKET_NAME);

        if (!exists) {
            const { error } = await supabase.storage.createBucket(BUCKET_NAME, {
                public: true,
                fileSizeLimit: 15 * 1024 * 1024, // 15 MB
                allowedMimeTypes: ['image/*'],
            });
            if (error && !error.message?.includes('already exists')) {
                console.error('❌ Không thể tạo bucket Supabase:', error.message);
                return false;
            }
            console.log(`✅ Đã tạo Supabase Storage bucket: ${BUCKET_NAME}`);
        }
        bucketReady = true;
        return true;
    } catch (e) {
        console.error('❌ ensureBucket thất bại:', e.message);
        return false;
    }
}

// ── Core Upload ───────────────────────────────────────────────────────────────

/**
 * Download an image from sourceUrl and upload to Supabase Storage.
 *
 * @param {string} sourceUrl  - Direct image URL (Drive, R2, etc.)
 * @param {string} photoId    - Unique photo ID (used as filename)
 * @param {string} albumId    - Album ID (organises into sub-folders)
 * @returns {Promise<string>} - Permanent public Supabase CDN URL
 */
async function cacheImageToSupabase(sourceUrl, photoId, albumId) {
    if (!supabase) throw new Error('Supabase chưa được cấu hình');

    // Ensure bucket exists before any operation
    const ready = await ensureBucket();
    if (!ready) throw new Error('Không thể khởi tạo bucket Supabase');

    const filePath = `${albumId}/${photoId}.jpg`;

    // Skip re-upload if already cached
    const alreadyCached = await isAlreadyCached(filePath);
    if (alreadyCached) {
        const { data } = supabase.storage.from(BUCKET_NAME).getPublicUrl(filePath);
        return data.publicUrl;
    }

    // Download from source
    const response = await fetch(sourceUrl, {
        headers: { 'Accept': 'image/*', 'User-Agent': 'chonanh-backend/1.0' },
        signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
        throw new Error(`Download thất bại (${response.status}): ${sourceUrl}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const contentType = response.headers.get('content-type') || 'image/jpeg';

    // Upload
    const { error } = await supabase.storage.from(BUCKET_NAME).upload(filePath, buffer, {
        contentType,
        cacheControl: String(365 * 24 * 3600), // 1 year
        upsert: true,
    });

    if (error) throw new Error(`Supabase upload thất bại: ${error.message}`);

    const { data } = supabase.storage.from(BUCKET_NAME).getPublicUrl(filePath);
    return data.publicUrl;
}

// ── Batch Upload ──────────────────────────────────────────────────────────────

/**
 * Upload multiple photos with concurrency control.
 *
 * @param {Array<{id, url}>} photos
 * @param {string}           albumId
 * @param {number}           concurrency  default 3
 */
async function batchCacheImages(photos, albumId, concurrency = 3) {
    if (!supabase) return { results: {}, errors: [{ id: 'config', error: 'Supabase chưa cấu hình' }] };

    const ready = await ensureBucket();
    if (!ready) return { results: {}, errors: [{ id: 'bucket', error: 'Không thể khởi tạo bucket' }] };

    const results = {};
    const errors  = [];
    let processed = 0;

    for (let i = 0; i < photos.length; i += concurrency) {
        const batch = photos.slice(i, i + concurrency);

        await Promise.all(batch.map(async (photo) => {
            try {
                const url = await cacheImageToSupabase(photo.url, photo.id, albumId);
                results[photo.id] = url;
                processed++;
                if (processed % 10 === 0 || processed === photos.length) {
                    console.log(`[Supabase] Cached ${processed}/${photos.length}`);
                }
            } catch (e) {
                errors.push({ id: photo.id, error: e.message });
                console.error(`[Supabase] ❌ ${photo.id}: ${e.message}`);
            }
        }));
    }

    if (errors.length) console.warn(`[Supabase] ⚠️  ${errors.length}/${photos.length} ảnh thất bại`);
    return { results, errors };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function isAlreadyCached(filePath) {
    if (!supabase) return false;
    try {
        const dir  = filePath.substring(0, filePath.lastIndexOf('/'));
        const name = filePath.substring(filePath.lastIndexOf('/') + 1);
        const { data } = await supabase.storage.from(BUCKET_NAME).list(dir, { search: name, limit: 1 });
        return !!(data && data.length > 0);
    } catch { return false; }
}

function getPublicUrl(albumId, photoId) {
    if (!supabase) return null;
    const { data } = supabase.storage.from(BUCKET_NAME).getPublicUrl(`${albumId}/${photoId}.jpg`);
    return data?.publicUrl || null;
}

module.exports = {
    supabase,
    cacheImageToSupabase,
    batchCacheImages,
    ensureBucket,
    getPublicUrl,
    BUCKET_NAME,
    isConfigured: () => !!supabase,
};
