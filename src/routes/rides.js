const express = require("express");
const pool = require("../db/pool");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

router.post("/", requireAuth, requireRole("passenger"), async (req, res) => {
  const {
    pickup_lat, pickup_lng, pickup_address, dropoff_lat, dropoff_lng, dropoff_address,
    payment_method = "pix",
  } = req.body;

  if (!["pix", "cartao", "especie"].includes(payment_method)) {
    return res.status(400).json({ error: "payment_method deve ser pix, cartao ou especie" });
  }

  try {
    const cityResult = await pool.query(`SELECT * FROM cities WHERE id = $1`, [req.user.city_id]);
    const city = cityResult.rows[0];
    if (!city || !city.is_active) {
      return res.status(400).json({ error: "Serviço ainda não está ativo nesta cidade" });
    }

    const currentHour = new Date().getHours();
    const zonesResult = await pool.query(
      `SELECT * FROM risk_zones WHERE city_id = $1 AND is_active = true`,
      [req.user.city_id]
    );
    const risk_warnings = zonesResult.rows.filter((zone) => {
      const withinHours =
        zone.active_from_hour == null ||
        (zone.active_from_hour <= zone.active_to_hour
          ? currentHour >= zone.active_from_hour && currentHour < zone.active_to_hour
          : currentHour >= zone.active_from_hour || currentHour < zone.active_to_hour);
      if (!withinHours) return false;

      const distToPickup = distanceKm(pickup_lat, pickup_lng, zone.center_lat, zone.center_lng) * 1000;
      const distToDropoff = distanceKm(dropoff_lat, dropoff_lng, zone.center_lat, zone.center_lng) * 1000;
      return distToPickup <= zone.radius_meters || distToDropoff <= zone.radius_meters;
    }).map((z) => ({ name: z.name, level: z.level }));

    const distance_km = distanceKm(pickup_lat, pickup_lng, dropoff_lat, dropoff_lng);
    const estimated_duration_min = Math.round((distance_km / 25) * 60);

    const fare_total =
      Number(city.base_fare) +
      Number(city.price_per_km) * distance_km +
      Number(city.price_per_min) * estimated_duration_min;

    const driver_payout = Math.round(fare_total * (city.driver_payout_pct / 100) * 100) / 100;
    const platform_fee = Math.round((fare_total - driver_payout) * 100) / 100;

    const result = await pool.query(
      `INSERT INTO rides (
          city_id, passenger_id, status, pickup_lat, pickup_lng, pickup_address,
          dropoff_lat, dropoff_lng, dropoff_address, distance_km, duration_min,
          payment_method, fare_total, platform_fee, driver_payout
       ) VALUES ($1,$2,'requested',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        req.user.city_id, req.user.id, pickup_lat, pickup_lng, pickup_address,
        dropoff_lat, dropoff_lng, dropoff_address, distance_km.toFixed(2),
        estimated_duration_min, payment_method, fare_total.toFixed(2), platform_fee.toFixed(2), driver_payout.toFixed(2),
      ]
    );

    const ride = { ...result.rows[0], risk_warnings };
    req.app.get("io")?.to(`city:${req.user.city_id}:drivers`).emit("ride:new", ride);
    res.status(201).json(ride);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao solicitar corrida" });
  }
});

router.post("/:id/accept", requireAuth, requireRole("driver"), async (req, res) => {
  try {
    const vehicle = await pool.query(`SELECT id FROM vehicles WHERE driver_id = $1 LIMIT 1`, [req.user.id]);
    if (!vehicle.rows[0]) return res.status(400).json({ error: "Cadastre um veículo antes de aceitar corridas" });

    const result = await pool.query(
      `UPDATE rides SET status = 'accepted', driver_id = $1, vehicle_id = $2, accepted_at = now()
       WHERE id = $3 AND status = 'requested'
       RETURNING *`,
      [req.user.id, vehicle.rows[0].id, req.params.id]
    );

    if (!result.rows[0]) {
      return res.status(409).json({ error: "Corrida já foi aceita por outro motorista ou não existe" });
    }

    const ride = result.rows[0];
    req.app.get("io")?.to(`ride:${ride.id}`).emit("ride:accepted", ride);
    res.json(ride);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao aceitar corrida" });
  }
});

router.patch("/:id/status", requireAuth, async (req, res) => {
  const { status } = req.body;
  const validStatuses = [
    "driver_arriving", "in_progress", "completed",
    "cancelled_by_passenger", "cancelled_by_driver",
  ];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: "Status inválido" });
  }

  const timestampColumn = {
    in_progress: "started_at",
    completed: "completed_at",
    cancelled_by_passenger: "cancelled_at",
    cancelled_by_driver: "cancelled_at",
  }[status];

  try {
    const query = timestampColumn
      ? `UPDATE rides SET status = $1, ${timestampColumn} = now() WHERE id = $2 RETURNING *`
      : `UPDATE rides SET status = $1 WHERE id = $2 RETURNING *`;

    const result = await pool.query(query, [status, req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: "Corrida não encontrada" });

    const ride = result.rows[0];

    if (status === "completed") {
      if (ride.payment_method === "especie") {
        await pool.query(
          `INSERT INTO payments (ride_id, method, amount, status, platform_fee_owed_by_driver, paid_at)
           VALUES ($1, 'especie', $2, 'paid', $3, now())
           ON CONFLICT (ride_id) DO NOTHING`,
          [ride.id, ride.fare_total, ride.platform_fee]
        );
        await pool.query(
          `INSERT INTO driver_balances (driver_id, amount_owed)
           VALUES ($1, $2)
           ON CONFLICT (driver_id)
           DO UPDATE SET amount_owed = driver_balances.amount_owed + $2, updated_at = now()`,
          [ride.driver_id, ride.platform_fee]
        );
      } else {
        await pool.query(
          `INSERT INTO payments (ride_id, method, amount, status)
           VALUES ($1, $2, $3, 'pending')
           ON CONFLICT (ride_id) DO NOTHING`,
          [ride.id, ride.payment_method, ride.fare_total]
        );
      }
    }

    req.app.get("io")?.to(`ride:${ride.id}`).emit("ride:status", ride);
    res.json(ride);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao atualizar status da corrida" });
  }
});

router.get("/open", requireAuth, requireRole("driver"), async (req, res) => {
  const result = await pool.query(
    `SELECT * FROM rides WHERE city_id = $1 AND status = 'requested' ORDER BY requested_at ASC LIMIT 10`,
    [req.user.city_id]
  );
  res.json(result.rows);
});

router.get("/:id", requireAuth, async (req, res) => {
  const result = await pool.query(`SELECT * FROM rides WHERE id = $1`, [req.params.id]);
  if (!result.rows[0]) return res.status(404).json({ error: "Corrida não encontrada" });
  res.json(result.rows[0]);
});

router.get("/", requireAuth, async (req, res) => {
  const column = req.user.role === "driver" ? "driver_id" : "passenger_id";
  const result = await pool.query(
    `SELECT * FROM rides WHERE ${column} = $1 ORDER BY requested_at DESC LIMIT 50`,
    [req.user.id]
  );
  res.json(result.rows);
});

module.exports = router;
