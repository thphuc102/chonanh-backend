require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

async function checkAll() {
    // === SUPABASE CHECK ===
    console.log('=== SUPABASE ===');
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    console.log('URL:', url ? 'OK' : 'MISSING');
    console.log('Key:', key ? 'OK (' + key.length + ' chars)' : 'MISSING');

    if (url && key) {
        const supabase = createClient(url, key, { auth: { persistSession: false } });
        const { data: buckets, error } = await supabase.storage.listBuckets();
        console.log('Storage:', error ? 'FAIL: ' + error.message : 'OK - buckets: ' + buckets.map(b => b.name).join(', '));
    }

    // === R2 CHECK ===
    console.log('\n=== CLOUDFLARE R2 ===');
    const r2Vars = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME', 'R2_PUBLIC_CUSTOM_DOMAIN'];
    r2Vars.forEach(v => console.log(v + ':', process.env[v] ? 'SET' : 'MISSING'));

    try {
        const { S3Client, ListBucketsCommand } = require('@aws-sdk/client-s3');
        const s3 = new S3Client({
            region: 'auto',
            endpoint: 'https://' + process.env.R2_ACCOUNT_ID + '.r2.cloudflarestorage.com',
            credentials: {
                accessKeyId: process.env.R2_ACCESS_KEY_ID,
                secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
            },
        });
        const result = await s3.send(new ListBucketsCommand({}));
        console.log('R2 Connection: OK - buckets:', result.Buckets?.map(b => b.Name).join(', ') || 'none');
    } catch (e) {
        console.log('R2 Connection: FAIL -', e.message?.substring(0, 150));
    }

    // === DB CHECK ===
    console.log('\n=== DATABASE ===');
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    try {
        await prisma.$queryRaw`SELECT 1`;
        const photoCount = await prisma.photo.count();
        const driveCount = await prisma.photo.count({
            where: { OR: [{ url: { contains: 'googleusercontent.com' } }, { url: { contains: 'drive.google.com' } }] }
        });
        const supaCount = await prisma.photo.count({ where: { url: { contains: 'supabase.co' } } });
        console.log('Prisma: OK');
        console.log('Photos total:', photoCount);
        console.log('  - Still on Google Drive:', driveCount);
        console.log('  - Migrated to Supabase:', supaCount);
    } catch (e) {
        console.log('Prisma: FAIL -', e.message?.substring(0, 150));
    }
    await prisma.$disconnect();
}

checkAll().catch(e => console.error('FATAL:', e));
