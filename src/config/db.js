const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT || 5433,
});

// Test the connection
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('Error connecting to the database', err);
  } else {
    console.log('Successfully connected to PostgreSQL database');
  }
});

module.exports = {
  query: (text, params) => pool.query(text, params),
};

/*
users columns:
id,
username,
email,
password_hash,
full_name,
created_at,
updated_at,
last_login,
is_active,
is_verified,

 */
