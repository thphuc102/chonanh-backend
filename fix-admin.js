require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { PrismaClient } = require('@prisma/client');

async function main() {
    const expectedIdentifier = process.env.MASTER_ADMIN_IDENTIFIER || 'thphuc@chonanh.com';
    const expectedPassword   = process.env.MASTER_ADMIN_PASSWORD || '10022006';
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    console.log('--- ADMIN AUTO-FIX DIAGNOSTIC ---');
    console.log('Expected Email/ID:', expectedIdentifier);
    console.log('Expected Password:', expectedPassword ? '********' : 'MISSING');
    console.log('Supabase URL:', supabaseUrl);
    console.log('Supabase Service Role Key:', supabaseServiceRoleKey ? 'PRESENT' : 'MISSING');

    if (!supabaseUrl || !supabaseServiceRoleKey) {
        console.error('CRITICAL ERROR: Supabase environment variables are missing.');
        return;
    }

    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
        auth: {
            autoRefreshToken: false,
            persistSession: false
        }
    });

    const prisma = new PrismaClient();

    try {
        const supabaseEmail = expectedIdentifier.includes('@') ? expectedIdentifier : `${expectedIdentifier}@chonanh.com`;
        console.log('Internal Supabase Email:', supabaseEmail);

        console.log('\n1. Fetching user list from Supabase Auth...');
        const { data: { users }, error: listError } = await supabase.auth.admin.listUsers();
        if (listError) {
            throw new Error(`Failed to list users: ${listError.message}`);
        }

        let authUser = users?.find(u => u.email === supabaseEmail);
        let authUid;

        if (authUser) {
            authUid = authUser.id;
            console.log(`✅ Found existing auth user: ${supabaseEmail} (ID: ${authUid})`);
            
            console.log('Updating user password and confirming email to ensure it is in a valid login state...');
            const { error: updateError } = await supabase.auth.admin.updateUserById(authUid, {
                password: expectedPassword,
                email_confirm: true,
                user_metadata: { name: 'SuperAdmin' }
            });
            
            if (updateError) {
                console.error('Failed to update auth user password:', updateError.message);
            } else {
                console.log('✅ Successfully updated auth user password/metadata.');
            }
        } else {
            console.log(`Auth user ${supabaseEmail} not found. Creating a new one...`);
            const { data: created, error: createError } = await supabase.auth.admin.createUser({
                email: supabaseEmail,
                password: expectedPassword,
                email_confirm: true,
                user_metadata: { name: 'SuperAdmin' }
            });

            if (createError) {
                throw new Error(`Failed to create auth user: ${createError.message}`);
            }

            authUser = created.user;
            authUid = authUser.id;
            console.log(`✅ Successfully created auth user: ${supabaseEmail} (ID: ${authUid})`);
        }

        console.log('\n2. Checking Prisma Database user...');
        let dbUser = await prisma.user.findUnique({
            where: { email: supabaseEmail }
        });

        if (dbUser) {
            console.log(`✅ Found existing user in Prisma: ${dbUser.email} (ID in DB: ${dbUser.id})`);
            if (dbUser.id !== authUid) {
                console.log(`⚠️ Database UID (${dbUser.id}) does not match Supabase Auth UID (${authUid}).`);
                console.log('Updating Database user UID to match Supabase Auth...');
                
                try {
                    await prisma.user.delete({ where: { email: supabaseEmail } });
                    console.log('Deleted old database user record.');
                } catch (delError) {
                    console.log(`Could not delete user: ${delError.message}. Attempting update instead...`);
                }
                
                dbUser = await prisma.user.create({
                    data: {
                        id: authUid,
                        name: 'SuperAdmin',
                        email: supabaseEmail,
                        role: 'SuperAdmin',
                        status: 'Active',
                        plan: 'enterprise',
                        albumsLimit: 9999,
                        storageLimitMB: 102400,
                        createdAt: new Date().toISOString()
                    }
                });
                console.log(`✅ Created database user record with matching UID: ${dbUser.id}`);
            } else {
                console.log('✅ Database ID matches Supabase Auth ID perfectly.');
            }
        } else {
            console.log('Database user not found. Creating database user record...');
            dbUser = await prisma.user.create({
                data: {
                    id: authUid,
                    name: 'SuperAdmin',
                    email: supabaseEmail,
                    role: 'SuperAdmin',
                    status: 'Active',
                    plan: 'enterprise',
                    albumsLimit: 9999,
                    storageLimitMB: 102400,
                    createdAt: new Date().toISOString()
                }
            });
            console.log(`✅ Created database user record: ${dbUser.id}`);
        }

        console.log('\n3. Testing login using signInWithPassword...');
        const regularClient = createClient(supabaseUrl, process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || supabaseServiceRoleKey);
        const { data, error: signInError } = await regularClient.auth.signInWithPassword({
            email: supabaseEmail,
            password: expectedPassword
        });

        if (signInError) {
            console.error('❌ Sign in failed:', signInError.message);
        } else {
            console.log('🎉 SUCCESS! Login verification successful.');
            console.log('Session access token length:', data.session?.access_token?.length);
        }

    } catch (e) {
        console.error('❌ ERROR RUNNING REPAIR:', e);
    } finally {
        await prisma.$disconnect();
    }
}

main();
