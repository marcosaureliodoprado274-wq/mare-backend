require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");

const authRoutes = require("./routes/auth");
const rideRoutes = require("./routes/rides");
const driverRoutes = require("./routes/drivers");
const safetyRoutes = require("./routes/safety");
const cityRoutes = require("./routes/cities");

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/auth", authRoutes);
app.use("/rides", rideRoutes);
app.use("/drivers", driverRoutes);
app.use("/safety", safetyRoutes);
app.use("/cities", cityRoutes);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Mapa em memória: driver_id -> socket.id (simples, funciona bem até escala média;
// pra multi-servidor no futuro, trocar por Redis adapter do socket.io)
const driverSockets = new Map();
app.set("io", io);
app.set("driverSockets", driverSockets);

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    socket.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    next(new Error("Autenticação inválida"));
  }
});

io.on("connection", (socket) => {
  const { id, role, city_id } = socket.user;

  if (role === "driver") {
    driverSockets.set(id, socket.id);
    socket.join(`city:${city_id}:drivers`);
  }
  if (role === "admin") {
    socket.join("admins");
  }

  // Motorista transmite localização ao vivo durante corrida
  socket.on("location:update", ({ ride_id, lat, lng }) => {
    if (ride_id) io.to(`ride:${ride_id}`).emit("driver:location", { lat, lng });
  });

  // Passageiro/motorista entram na "sala" da corrida pra receber updates
  socket.on("ride:join", (rideId) => socket.join(`ride:${rideId}`));

  socket.on("disconnect", () => {
    if (role === "driver") driverSockets.delete(id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Maré API rodando na porta ${PORT}`));
