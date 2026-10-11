const { Pool } = require('pg');

console.log("=== RENDER RUNTIME ENV CHECK ===");
console.log("DATABASE_URL raw value:", process.env.DATABASE_URL ? "FOUND (length: " + process.env.DATABASE_URL.length + ")" : "UNDEFINED");
console.log("Available Env Keys:", Object.keys(process.env).filter(k => !k.startsWith('npm_') && k !== 'PATH'));
console.log("================================");

const connectionString = process.env.DATABASE_URL ? process.env.DATABASE_URL.trim() : undefined;

const pool = new Pool(
  connectionString
    ? {
        connectionString,
        ssl: { rejectUnauthorized: false }
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
