const express = require("express");
const pool = require("../db/pool");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

// ---------------------------------------------------------------------------
// POST /safety/alert — botão de emergência (passageiro ou motorista)
// body: { ride_id, type, lat, lng, notes }
// ---------------------------------------------------------------------------
router.post("/alert", requireAuth, async (req, res) => {
  const { ride_id, type, lat, lng, notes } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO safety_alerts (ride_id, reported_by, type, level, lat, lng, notes)
       VALUES ($1,$2,$3,'alta',$4,$5,$6) RETURNING *`,
      [ride_id || null, req.user.id, type || "panic_button", lat ?? null, lng ?? null, notes || null]
    );
    const alert = result.rows[0];

    // Notifica o painel admin em tempo real
    req.app.get("io")?.to("admins").emit("safety:alert", alert);

    res.status(201).json(alert);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao registrar alerta" });
  }
});

// ---------------------------------------------------------------------------
// GET /safety/alerts — lista para o painel admin
// ---------------------------------------------------------------------------
router.get("/alerts", requireAuth, requireRole("admin"), async (req, res) => {
  const result = await pool.query(
    `SELECT sa.*, u.full_name AS reported_by_name
     FROM safety_alerts sa JOIN users u ON u.id = sa.reported_by
     ORDER BY sa.created_at DESC LIMIT 100`
  );
  res.json(result.rows);
});

// ---------------------------------------------------------------------------
// PATCH /safety/alerts/:id — admin atualiza status do alerta
// ---------------------------------------------------------------------------
router.patch("/alerts/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const { status } = req.body;
  const resolvedAt = status === "resolved" ? "now()" : "NULL";
  const result = await pool.query(
    `UPDATE safety_alerts SET status = $1, resolved_at = ${resolvedAt} WHERE id = $2 RETURNING *`,
    [status, req.params.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Alerta não encontrado" });
  res.json(result.rows[0]);
});

// ---------------------------------------------------------------------------
// ZONAS DE RISCO — cadastradas pelo admin, sempre com uma fonte objetiva
// (boletim de ocorrência, dado público da SSPDS, relato verificado)
// ---------------------------------------------------------------------------

// GET /safety/risk-zones — lista zonas ativas da cidade do usuário logado
router.get("/risk-zones", requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT id, name, center_lat, center_lng, radius_meters, level,
            active_from_hour, active_to_hour
     FROM risk_zones WHERE city_id = $1 AND is_active = true`,
    [req.user.city_id]
  );
  res.json(result.rows);
});

// POST /safety/risk-zones — admin cadastra, sempre com fonte e evidência
// body: { name, center_lat, center_lng, radius_meters, level, source,
//         active_from_hour, active_to_hour, evidence_note }
router.post("/risk-zones", requireAuth, requireRole("admin"), async (req, res) => {
  const {
    name, center_lat, center_lng, radius_meters, level, source,
    active_from_hour, active_to_hour, evidence_note,
  } = req.body;

  if (!name || !center_lat || !center_lng || !level || !source || !evidence_note) {
    return res.status(400).json({
      error: "name, center_lat, center_lng, level, source e evidence_note são obrigatórios — toda zona precisa de uma fonte verificável",
    });
  }

  const result = await pool.query(
    `INSERT INTO risk_zones (
        city_id, name, center_lat, center_lng, radius_meters, level, source,
        active_from_hour, active_to_hour, evidence_note, reviewed_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [
      req.user.city_id, name, center_lat, center_lng, radius_meters || 300, level, source,
      active_from_hour ?? null, active_to_hour ?? null, evidence_note, req.user.id,
    ]
  );
  res.status(201).json(result.rows[0]);
});

// PATCH /safety/risk-zones/:id/deactivate — remove uma zona (ex: dado desatualizado)
router.patch("/risk-zones/:id/deactivate", requireAuth, requireRole("admin"), async (req, res) => {
  const result = await pool.query(
    `UPDATE risk_zones SET is_active = false WHERE id = $1 RETURNING *`,
    [req.params.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Zona não encontrada" });
  res.json(result.rows[0]);
});

module.exports = router;
