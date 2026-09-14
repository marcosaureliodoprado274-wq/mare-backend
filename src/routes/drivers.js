const express = require("express");
const pool = require("../db/pool");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

// ---------------------------------------------------------------------------
// PATCH /drivers/status — motorista fica online/offline e atualiza localização
// body: { is_online, lat, lng }
// ---------------------------------------------------------------------------
router.patch("/status", requireAuth, requireRole("driver"), async (req, res) => {
  const { is_online, lat, lng } = req.body;
  try {
    const result = await pool.query(
      `UPDATE driver_status SET is_online = $1, current_lat = $2, current_lng = $3, updated_at = now()
       WHERE driver_id = $4 RETURNING *`,
      [is_online, lat ?? null, lng ?? null, req.user.id]
    );

    // entra/sai da sala de socket que recebe notificações de novas corridas
    const io = req.app.get("io");
    const socketId = req.app.get("driverSockets")?.get(req.user.id);
    if (io && socketId) {
      const room = `city:${req.user.city_id}:drivers`;
      if (is_online) io.sockets.sockets.get(socketId)?.join(room);
      else io.sockets.sockets.get(socketId)?.leave(room);
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao atualizar status" });
  }
});

// ---------------------------------------------------------------------------
// POST /drivers/vehicle — cadastra o veículo do motorista
// ---------------------------------------------------------------------------
router.post("/vehicle", requireAuth, requireRole("driver"), async (req, res) => {
  const { make, model, plate, color, vehicle_type } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO vehicles (driver_id, make, model, plate, color, vehicle_type)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user.id, make, model, plate, color || null, vehicle_type || "moto"]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Placa já cadastrada" });
    console.error(err);
    res.status(500).json({ error: "Erro ao cadastrar veículo" });
  }
});

// ---------------------------------------------------------------------------
// GET /drivers/earnings/today — ganhos do dia (repasse transparente)
// ---------------------------------------------------------------------------
router.get("/earnings/today", requireAuth, requireRole("driver"), async (req, res) => {
  const result = await pool.query(
    `SELECT COUNT(*) AS rides, COALESCE(SUM(driver_payout), 0) AS total
     FROM rides
     WHERE driver_id = $1 AND status = 'completed' AND completed_at::date = CURRENT_DATE`,
    [req.user.id]
  );
  res.json(result.rows[0]);
});

// ---------------------------------------------------------------------------
// GET /drivers/balance — quanto o motorista deve à plataforma (corridas em espécie)
// ---------------------------------------------------------------------------
router.get("/balance", requireAuth, requireRole("driver"), async (req, res) => {
  const result = await pool.query(
    `SELECT amount_owed FROM driver_balances WHERE driver_id = $1`,
    [req.user.id]
  );
  res.json({ amount_owed: result.rows[0]?.amount_owed ?? 0 });
});

module.exports = router;
