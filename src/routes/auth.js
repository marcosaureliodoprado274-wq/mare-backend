const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db/pool");

const router = express.Router();

// ---------------------------------------------------------------------------
// POST /auth/register — cria passageiro ou motorista
// body: { role, full_name, cpf, phone, email, password, city_id }
// ---------------------------------------------------------------------------
router.post("/register", async (req, res) => {
  const { role, full_name, cpf, phone, email, password, city_id } = req.body;

  if (!["passenger", "driver"].includes(role)) {
    return res.status(400).json({ error: "role deve ser 'passenger' ou 'driver'" });
  }
  if (!full_name || !cpf || !phone || !password || !city_id) {
    return res.status(400).json({ error: "Campos obrigatórios faltando" });
  }

  try {
    const password_hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (role, full_name, cpf, phone, email, password_hash, city_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, role, full_name, city_id`,
      [role, full_name, cpf, phone, email || null, password_hash, city_id]
    );

    const user = result.rows[0];

    // Se for motorista, cria o registro de verificação pendente automaticamente
    if (role === "driver") {
      await pool.query(
        `INSERT INTO driver_verifications (user_id, status) VALUES ($1, 'pending')`,
        [user.id]
      );
      await pool.query(
        `INSERT INTO driver_status (driver_id, is_online) VALUES ($1, false)`,
        [user.id]
      );
    }

    const token = jwt.sign(
      { id: user.id, role: user.role, city_id: user.city_id },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );

    res.status(201).json({ user, token });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "CPF, telefone ou e-mail já cadastrado" });
    }
    console.error(err);
    res.status(500).json({ error: "Erro ao registrar usuário" });
  }
});

// ---------------------------------------------------------------------------
// POST /auth/login — body: { phone, password }
// ---------------------------------------------------------------------------
router.post("/login", async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) {
    return res.status(400).json({ error: "Telefone e senha são obrigatórios" });
  }

  try {
    const result = await pool.query(`SELECT * FROM users WHERE phone = $1`, [phone]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: "Credenciais inválidas" });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: "Credenciais inválidas" });

    const token = jwt.sign(
      { id: user.id, role: user.role, city_id: user.city_id },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );

    delete user.password_hash;
    res.json({ user, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao fazer login" });
  }
});

module.exports = router;
