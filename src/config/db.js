const { Pool } = require('pg');
require('dotenv').config();

// Configure connection pool
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT || 5432,
  ssl: false, //process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: parseInt(process.env.DB_POOL_MAX || '20', 10),     // Maximum clients in pool
  idleTimeoutMillis: 30000,                               // Close idle clients after 30 seconds
  connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT || '7000', 10), // Allow slower connections
});

// Connection error handling
pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

// Test the connection asynchronously
(async () => {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW()');
    client.release();
    console.log('Successfully connected to PostgreSQL database at', result.rows[0].now);
  } catch (err) {
    console.error('Error connecting to the database', err);
  }
})();

// Improved query function with error handling
const isConnectionTimeoutError = (error) =>
  error?.message?.includes('timeout exceeded') ||
  error?.message?.includes('ETIMEDOUT');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const query = async (text, params, attempt = 0) => {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    if (duration > 500) {
      console.log('Slow query:', { text, duration, rows: result.rowCount });
    }
    return result;
  } catch (error) {
    console.error('Query error:', error.message, { text, params });
    if (attempt < 2 && isConnectionTimeoutError(error)) {
      const backoff = 500 * (attempt + 1);
      console.warn(`Retrying query after ${backoff}ms due to connection timeout (attempt ${attempt + 1})`);
      await wait(backoff);
      return query(text, params, attempt + 1);
    }
    throw error;
  }
};

const connectWithRetry = async (retries = 3) => {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await pool.connect();
    } catch (error) {
      if (attempt >= retries || !isConnectionTimeoutError(error)) {
        throw error;
      }
      const delay = 500 * (attempt + 1);
      console.warn(`Database connection timeout (attempt ${attempt + 1}). Retrying in ${delay}ms...`);
      await wait(delay);
    }
  }
};

// Transaction helper
const transaction = async (callback) => {
  const client = await connectWithRetry();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

module.exports = {
  pool,
  query,
  transaction
};
