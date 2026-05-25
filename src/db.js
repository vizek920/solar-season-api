const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.on('connect', () => {
  console.log('✅ Connected to Neon.tech database');
});

pool.on('error', (err) => {
  console.error('❌ Database error:', err.message);
});

module.exports = pool;
