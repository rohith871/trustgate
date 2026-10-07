const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'trustgate_db',
});

async function runAuthMigration() {
  const client = await pool.connect();
  try {
    console.log('Starting Auth & Exact User Targeting Migration...');
    await client.query('BEGIN');

    // 1. Add target_user_id to verification_requests
    await client.query(`
      ALTER TABLE verification_requests 
      ADD COLUMN IF NOT EXISTS target_user_id BIGINT REFERENCES users(user_id) ON DELETE CASCADE;
    `);

    // 2. Set target_user_id = 1 for existing requests
    await client.query(`
      UPDATE verification_requests 
      SET target_user_id = 1 
      WHERE target_user_id IS NULL;
    `);

    // 3. Hash standard passwords for demo users
    const defaultPasswordHash = await bcrypt.hash('password123', 10);

    // Update users password_hash if dummy
    await client.query(`
      UPDATE users 
      SET password_hash = $1 
      WHERE email = 'rohan.k@trustgate.id' OR password_hash LIKE '%dummyhash%';
    `, [defaultPasswordHash]);

    // Ensure default user exists
    const userCheck = await client.query(`SELECT user_id FROM users WHERE email = 'rohan.k@trustgate.id'`);
    if (userCheck.rows.length === 0) {
      await client.query(`
        INSERT INTO users (name, email, password_hash)
        VALUES ('Rohan Krishnan', 'rohan.k@trustgate.id', $1)
      `, [defaultPasswordHash]);
    }

    // Update org_staff password_hash
    await client.query(`
      UPDATE org_staff 
      SET password_hash = $1 
      WHERE email = 'priya.m@cgh.org' OR password_hash LIKE '%dummyhash%';
    `, [defaultPasswordHash]);

    // Ensure default org staff exists
    const staffCheck = await client.query(`SELECT staff_id FROM org_staff WHERE email = 'priya.m@cgh.org'`);
    if (staffCheck.rows.length === 0) {
      // Check org 1
      const orgCheck = await client.query(`SELECT org_id FROM organizations LIMIT 1`);
      let orgId = orgCheck.rows.length > 0 ? orgCheck.rows[0].org_id : 1;
      if (orgCheck.rows.length === 0) {
        const newOrg = await client.query(`
          INSERT INTO organizations (org_name, org_type, registration_number, verification_status)
          VALUES ('City General Hospital', 'Hospital', 'REG-CGH-2026', 'approved')
          RETURNING org_id
        `);
        orgId = newOrg.rows[0].org_id;
      }

      await client.query(`
        INSERT INTO org_staff (org_id, name, email, password_hash, role)
        VALUES ($1, 'Priya M.', 'priya.m@cgh.org', $2, 'ORG_VERIFIER')
      `, [orgId, defaultPasswordHash]);
    }

    await client.query('COMMIT');
    console.log('✓ Auth & Target User Migration complete!');

    const usersRes = await client.query('SELECT user_id, name, email FROM users');
    console.log('\n--- Individual Users ---');
    console.table(usersRes.rows);

    const staffRes = await client.query('SELECT s.staff_id, s.name, s.email, s.org_id, o.org_name FROM org_staff s JOIN organizations o ON s.org_id = o.org_id');
    console.log('\n--- Org Staff Members ---');
    console.table(staffRes.rows);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration Error:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

runAuthMigration();
