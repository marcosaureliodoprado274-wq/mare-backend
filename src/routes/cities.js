const express = require("express");
const pool = require("../db/pool");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

// GET /cities — lista cidades ativas (usado na tela de cadastro do app)
router.get("/", async (req, res) => {
  const result = await pool.query(`SELECT id, name, state FROM cities WHERE is_active = true ORDER BY name`);
  res.json(result.rows);
});

// POST /cities — admin cadastra uma nova cidade para expansão (fica inativa até lançar)
router.post("/", requireAuth, requireRole("admin"), async (req, res) => {
  const { name, state, base_fare, price_per_km, price_per_min, driver_payout_pct } = req.body;
  const result = await pool.query(
    `INSERT INTO cities (name, state, base_fare, price_per_km, price_per_min, driver_payout_pct, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,false) RETURNING *`,
    [name, state, base_fare ?? 5.0, price_per_km ?? 1.8, price_per_min ?? 0.25, driver_payout_pct ?? 90.0]
  );
  res.status(201).json(result.rows[0]);
});

// PATCH /cities/:id/activate — admin lança oficialmente a cidade
router.patch("/:id/activate", requireAuth, requireRole("admin"), async (req, res) => {
  const result = await pool.query(
    `UPDATE cities SET is_active = true WHERE id = $1 RETURNING *`,
    [req.params.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Cidade não encontrada" });
  res.json(result.rows[0]);
});

module.exports = router;
