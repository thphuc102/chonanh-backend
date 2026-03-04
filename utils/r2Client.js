const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');

async function uploadFromUrlToR2(url, originalName, albumId) {
    const ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
    const ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
    const SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
    const BUCKET_NAME = process.env.R2_BUCKET_NAME;
    const PUBLIC_DOMAIN = process.env.R2_PUBLIC_CUSTOM_DOMAIN;

    if (!ACCOUNT_ID || !ACCESS_KEY_ID || !SECRET_ACCESS_KEY || !BUCKET_NAME || !PUBLIC_DOMAIN) {
        throw new Error("Tài khoản R2 chưa được cấu hình đầy đủ trong .env");
    }

    const s3Client = new S3Client({
        region: "auto",
        endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: ACCESS_KEY_ID,
            secretAccessKey: SECRET_ACCESS_KEY,
        },
    });

    try {
        // 1. Download image from Google Drive URL
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Không thể tải ảnh từ URL gốc: ${response.statusText}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const contentType = response.headers.get('content-type') || 'image/jpeg';

        // 2. Generate unique filename (keep extension if possible)
        const extMatch = originalName.match(/\.([^.]+)$/);
        const ext = extMatch ? extMatch[1] : 'jpg';
        const hash = crypto.randomUUID();
        const fileName = `albums/${albumId}/${hash}.${ext}`;

        // 3. Upload to R2 Bucket
        await s3Client.send(new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: fileName,
            Body: buffer,
            ContentType: contentType,
        }));

        // 4. Return the new Public URL
        const publicUrl = PUBLIC_DOMAIN.endsWith('/') ? PUBLIC_DOMAIN.slice(0, -1) : PUBLIC_DOMAIN;
        return `${publicUrl}/${fileName}`;
    } catch (error) {
        console.error("Lỗi khi tải lên R2:", error);
        throw error;
    }
}

module.exports = {
    uploadFromUrlToR2
};
