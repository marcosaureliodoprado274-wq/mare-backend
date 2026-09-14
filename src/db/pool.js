const { Pool } = require("pg");

// Usa a variável DATABASE_URL (padrão em Railway, Render, Supabase, etc.)
// Exemplo local: postgres://usuario:senha@localhost:5432/mare
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
});

module.exports = pool;
