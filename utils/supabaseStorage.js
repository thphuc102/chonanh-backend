/**
 * Supabase Storage Image Cache Utility
 * 
 * Downloads images from Google Drive (via proxy) and caches them in
 * Supabase Storage for fast, permanent CDN delivery.
 * 
 * Environment variables required:
 * - SUPABASE_URL: e.g., https://xyz.supabase.co
 * - SUPABASE_SERVICE_ROLE_KEY: Server-side key (bypasses RLS)
 * - FIREBASE_HOSTING_URL: e.g., https://chonanh-a9d23.web.app (optional)
 */

const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
    console.warn('⚠️ Supabase chưa được cấu hình (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY). Image caching tắt.');
}

const supabase = supabaseUrl && supabaseServiceKey
    ? createClient(supabaseUrl, supabaseServiceKey)
    : null;

const BUCKET_NAME = 'album-photos';
const FIREBASE_HOSTING_URL = process.env.FIREBASE_HOSTING_URL || 'https://chonanh-a9d23.web.app';

/**
 * Ensure the storage bucket exists, create if not
 */
let bucketReady = false;
async function ensureBucket() {
    if (!supabase || bucketReady) return !!supabase;

    try {
        const { data: buckets } = await supabase.storage.listBuckets();
        const exists = buckets?.some(b => b.name === BUCKET_NAME);

        if (!exists) {
            const { error } = await supabase.storage.createBucket(BUCKET_NAME, {
                public: true,
                fileSizeLimit: 15728640, // 15MB max per image
                allowedMimeTypes: ['image/*']
            });
            if (error && !error.message?.includes('already exists')) {
                console.error('❌ Không thể tạo bucket:', error.message);
                return false;
            }
            console.log(`✅ Đã tạo Supabase Storage bucket: ${BUCKET_NAME}`);
        }
        bucketReady = true;
        return true;
    } catch (e) {
        console.error('❌ Kiểm tra bucket thất bại:', e.message);
        return false;
    }
}

/**
 * Check if an image is already cached in Supabase Storage
 */
async function isAlreadyCached(filePath) {
    if (!supabase) return false;

    try {
        // List files in the directory to check existence
        const dirPath = filePath.substring(0, filePath.lastIndexOf('/'));
        const fileName = filePath.substring(filePath.lastIndexOf('/') + 1);

        const { data } = await supabase.storage
            .from(BUCKET_NAME)
            .list(dirPath, { search: fileName, limit: 1 });

        return data && data.length > 0;
    } catch {
        return false;
    }
}

/**
 * Download image from Drive proxy and upload to Supabase Storage.
 * Returns the public CDN URL.
 * 
 * @param {string} driveFileId - The Google Drive file ID
 * @param {string} albumId - Album ID for folder organization
 * @returns {Promise<string>} Supabase public URL
 */
async function cacheImageToSupabase(driveFileId, albumId) {
    if (!supabase) throw new Error('Supabase chưa được cấu hình');

    const filePath = `${albumId}/${driveFileId}.jpg`;

    // Check if already cached (skip re-download)
    const cached = await isAlreadyCached(filePath);
    if (cached) {
        const { data: urlData } = supabase.storage
            .from(BUCKET_NAME)
            .getPublicUrl(filePath);
        return urlData.publicUrl;
    }

    // Download from Drive proxy
    const proxyUrl = `${FIREBASE_HOSTING_URL}/driveimg/${driveFileId}?sz=s1200`;

    const response = await fetch(proxyUrl, {
        headers: { 'Accept': 'image/*' },
        signal: AbortSignal.timeout(30000), // 30s timeout per image
    });

    if (!response.ok) {
        throw new Error(`Download thất bại: ${response.status} ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const contentType = response.headers.get('content-type') || 'image/jpeg';

    // Upload to Supabase Storage
    const { error } = await supabase.storage
        .from(BUCKET_NAME)
        .upload(filePath, buffer, {
            contentType,
            cacheControl: '31536000', // 1 year browser cache
            upsert: true,
        });

    if (error) {
        throw new Error(`Upload Supabase thất bại: ${error.message}`);
    }

    // Return permanent public CDN URL
    const { data: urlData } = supabase.storage
        .from(BUCKET_NAME)
        .getPublicUrl(filePath);

    return urlData.publicUrl;
}

/**
 * Batch cache multiple photos to Supabase Storage.
 * Processes in parallel with concurrency control.
 * 
 * @param {Array<{id: string, url: string}>} photos - Photos to cache
 * @param {string} albumId - Album ID
 * @param {number} concurrency - Max parallel downloads (default: 3)
 * @returns {Promise<{results: Object, errors: Array}>}
 */
async function batchCacheImages(photos, albumId, concurrency = 3) {
    if (!supabase) return { results: {}, errors: [{ id: 'config', error: 'Supabase chưa cấu hình' }] };

    const ready = await ensureBucket();
    if (!ready) return { results: {}, errors: [{ id: 'bucket', error: 'Không thể tạo bucket' }] };

    const results = {};
    const errors = [];
    let processed = 0;

    // Process in batches for concurrency control
    for (let i = 0; i < photos.length; i += concurrency) {
        const batch = photos.slice(i, i + concurrency);
        const promises = batch.map(async (photo) => {
            try {
                // Extract Drive file ID from /driveimg/{id} URL or use photo.id
                let driveFileId = photo.id;
                if (photo.url && photo.url.startsWith('/driveimg/')) {
                    driveFileId = photo.url.split('/driveimg/')[1]?.split('?')[0] || photo.id;
                }

                const supabaseUrl = await cacheImageToSupabase(driveFileId, albumId);
                results[photo.id] = supabaseUrl;
                processed++;

                if (processed % 10 === 0 || processed === photos.length) {
                    console.log(`📸 Cached ${processed}/${photos.length} photos`);
                }
            } catch (e) {
                errors.push({ id: photo.id, error: e.message });
                console.error(`❌ Cache photo ${photo.id} thất bại:`, e.message);
            }
        });

        await Promise.all(promises);
    }

    if (errors.length > 0) {
        console.warn(`⚠️ ${errors.length}/${photos.length} ảnh cache thất bại`);
    }

    return { results, errors };
}

/**
 * Get the public URL for a cached image.
 * Returns null if not configured.
 */
function getPublicUrl(albumId, driveFileId) {
    if (!supabase) return null;
    const filePath = `${albumId}/${driveFileId}.jpg`;
    const { data } = supabase.storage.from(BUCKET_NAME).getPublicUrl(filePath);
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
