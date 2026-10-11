const { Pool } = require('pg');
require('dotenv').config();

// Debugging block to see what Render is actually injecting
console.log("=== DB CONFIG DEBUG ===");
console.log("NODE_ENV:", process.env.NODE_ENV);
console.log("DATABASE_URL is set:", !!process.env.DATABASE_URL);
if (process.env.DATABASE_URL) {
  console.log("DATABASE_URL prefix:", process.env.DATABASE_URL.substring(0, 20) + "...");
} else {
  console.error("❌ CRITICAL: DATABASE_URL is missing from process.env!");
}
console.log("=======================");

const connectionString = process.env.DATABASE_URL;

const pool = new Pool(
  connectionString
    ? {
        connectionString,
        ssl: {
          rejectUnauthorized: false // Required for Neon cloud SSL
        }
      }
    : {
        host: process.env.DB_HOST || 'localhost',
        port: process.env.DB_PORT || 5432,
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME || 'trustgate_db',
      }
);

pool.on('connect', () => {
  console.log('✅ Connected to PostgreSQL database successfully!');
});

pool.on('error', (err) => {
  console.error('❌ Unexpected database error:', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
