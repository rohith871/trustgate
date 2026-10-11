const { Pool } = require('pg');
require('dotenv').config();

// Trim whitespace/newlines to prevent copy-paste clipping bugs from Render/Neon
const connectionString = process.env.DATABASE_URL ? process.env.DATABASE_URL.trim() : undefined;

console.log("🔍 DB Config Check -> DATABASE_URL loaded:", !!connectionString);

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
