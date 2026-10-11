console.log("=== SCRIPT STARTING ===");

const { Pool } = require('pg');

console.log("Loaded pg module successfully.");

const connectionString = "postgresql://neondb_owner:npg_k7FLvuXc8xAh@ep-solitary-sea-b4rmm4pe-pooler.c-6.us-east-2.aws.neon.tech/neondb?sslmode=require";

const pool = new Pool({
  connectionString,
  ssl: {
    rejectUnauthorized: false
  },
  connectionTimeoutMillis: 5000 // Fail after 5 seconds instead of hanging forever
});

async function testConnection() {
  try {
    console.log("🔄 Attempting to connect to Neon...");
    const client = await pool.connect();
    const res = await client.query('SELECT NOW()');
    console.log("✅ SUCCESS! Connected to database at:", res.rows[0].now);
    client.release();
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error("❌ FAILED to connect:", err.message);
    await pool.end();
    process.exit(1);
  }
}

testConnection();
