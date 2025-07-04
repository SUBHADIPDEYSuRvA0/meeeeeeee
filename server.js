const express = require("express")
const http = require("http")
const https = require("https")
const socketIo = require("socket.io")
const mediasoup = require("mediasoup")
const { v4: uuidv4 } = require("uuid")
const path = require("path")
const fs = require("fs")
const cors = require("cors")
const helmet = require("helmet")
const compression = require("compression")
require("dotenv").config()

const app = express()

// Security and performance middleware
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }),
)
app.use(compression())
app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

let server
if (process.env.NODE_ENV === "production") {
  if (!process.env.SSL_CERT_PATH || !process.env.SSL_KEY_PATH) {
    console.error("SSL certificate paths not provided in production environment")
    process.exit(1)
  }
  server = https.createServer(
    {
      cert: fs.readFileSync(process.env.SSL_CERT_PATH),
      key: fs.readFileSync(process.env.SSL_KEY_PATH),
    },
    app,
  )
} else {
  server = http.createServer(app)
}

const io = socketIo(server, {
  cors: {
    origin:
      process.env.NODE_ENV === "production"
        ? ["https://sampledemo.shop", "https://your-domain.com"]
        : ["http://localhost:3000", "http://127.0.0.1:3000"],
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["websocket", "polling"],
})

app.set("view engine", "ejs")
app.use(express.static(path.join(__dirname, "public")))

// Mediasoup configuration
const mediaCodecs = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    parameters: {
      "x-google-start-bitrate": 1000,
    },
  },
  {
    kind: "video",
    mimeType: "video/VP9",
    clockRate: 90000,
    parameters: {
      "profile-id": 2,
      "x-google-start-bitrate": 1000,
    },
  },
  {
    kind: "video",
    mimeType: "video/h264",
    clockRate: 90000,
    parameters: {
      "packetization-mode": 1,
      "profile-level-id": "4d0032",
      "level-asymmetry-allowed": 1,
      "x-google-start-bitrate": 1000,
    },
  },
]

const webRtcTransportOptions = {
  listenIps: [
    {
      ip: "0.0.0.0",
      announcedIp: process.env.ANNOUNCED_IP || "127.0.0.1",
    },
  ],
  enableUdp: true,
  enableTcp: true,
  preferUdp: true,
}

// Global variables
let worker
let router
const rooms = new Map()
const peers = new Map()

// Initialize mediasoup
async function initializeMediasoup() {
  worker = await mediasoup.createWorker({
    logLevel: "warn",
    rtcMinPort: 10000,
    rtcMaxPort: 10100,
  })

  worker.on("died", (error) => {
    console.error("mediasoup worker died", error)
    setTimeout(() => process.exit(1), 2000)
  })

  router = await worker.createRouter({ mediaCodecs })
  console.log("Mediasoup initialized successfully")
}

// Room management
class Room {
  constructor(roomId) {
    this.id = roomId
    this.peers = new Map()
    this.createdAt = new Date()
  }

  addPeer(peer) {
    this.peers.set(peer.id, peer)
  }

  removePeer(peerId) {
    this.peers.delete(peerId)
  }

  getPeers() {
    return Array.from(this.peers.values())
  }

  isEmpty() {
    return this.peers.size === 0
  }
}

class Peer {
  constructor(socketId, email, roomId) {
    this.id = socketId
    this.email = email
    this.roomId = roomId
    this.transports = new Map()
    this.producers = new Map()
    this.consumers = new Map()
    this.device = null
  }

  addTransport(transport) {
    this.transports.set(transport.id, transport)
  }

  addProducer(producer) {
    this.producers.set(producer.id, producer)
  }

  addConsumer(consumer) {
    this.consumers.set(consumer.id, consumer)
  }

  removeConsumer(consumerId) {
    this.consumers.delete(consumerId)
  }

  close() {
    this.transports.forEach((transport) => transport.close())
    this.producers.forEach((producer) => producer.close())
    this.consumers.forEach((consumer) => consumer.close())
  }
}

// Routes
app.get("/", (req, res) => {
  res.render("index")
})

app.get("/join", (req, res) => {
  const { email = "guest", code } = req.query

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.render("join", { error: "Please enter a valid email." })
  }

  if (code) {
    if (!/^[a-zA-Z0-9-]{6,36}$/.test(code)) {
      return res.render("join", { error: "Invalid meeting code." })
    }

    if (!rooms.has(code)) {
      rooms.set(code, new Room(code))
    }

    res.render("meeting", { email, roomId: code })
  } else {
    res.render("join", { error: req.query.code ? "Please enter a meeting code." : "" })
  }
})

app.get("/join/:email/:code", (req, res) => {
  const { email, code } = req.params

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.render("join", { error: "Please enter a valid email." })
  }

  if (!/^[a-zA-Z0-9-]{6,36}$/.test(code)) {
    return res.render("join", { error: "Invalid meeting code." })
  }

  if (!rooms.has(code)) {
    rooms.set(code, new Room(code))
  }

  res.render("meeting", { email, roomId: code })
})

app.get("/create", (req, res) => {
  const roomId = uuidv4()
  rooms.set(roomId, new Room(roomId))
  res.redirect(`/join/guest/${roomId}`)
})

// Get router RTP capabilities
app.get("/api/router-capabilities", (req, res) => {
  res.json(router.rtpCapabilities)
})

// Socket.IO connection handling
io.on("connection", (socket) => {
  console.log("New socket connection:", socket.id)

  socket.on("join-room", async ({ roomId, email, rtpCapabilities }) => {
    try {
      socket.join(roomId)

      if (!rooms.has(roomId)) {
        rooms.set(roomId, new Room(roomId))
      }

      const room = rooms.get(roomId)
      const peer = new Peer(socket.id, email, roomId)
      peer.device = rtpCapabilities

      room.addPeer(peer)
      peers.set(socket.id, peer)

      console.log(`User ${email} joined room ${roomId}`)

      // Send existing peers to new user
      const existingPeers = room
        .getPeers()
        .filter((p) => p.id !== socket.id)
        .map((p) => ({ id: p.id, email: p.email }))

      socket.emit("existing-peers", existingPeers)

      // Notify other peers about new user
      socket.to(roomId).emit("user-joined", { id: socket.id, email })
    } catch (error) {
      console.error("Error joining room:", error)
      socket.emit("error", { message: "Failed to join room" })
    }
  })

  socket.on("create-transport", async ({ direction, roomId }, callback) => {
    try {
      const transport = await router.createWebRtcTransport(webRtcTransportOptions)
      const peer = peers.get(socket.id)

      if (!peer) {
        throw new Error("Peer not found")
      }

      peer.addTransport(transport)

      transport.on("dtlsstatechange", (dtlsState) => {
        if (dtlsState === "closed") {
          transport.close()
        }
      })

      callback({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      })
    } catch (error) {
      console.error("Error creating transport:", error)
      callback({ error: error.message })
    }
  })

  socket.on("connect-transport", async ({ transportId, dtlsParameters }, callback) => {
    try {
      const peer = peers.get(socket.id)
      const transport = peer.transports.get(transportId)

      if (!transport) {
        throw new Error("Transport not found")
      }

      await transport.connect({ dtlsParameters })
      callback({ success: true })
    } catch (error) {
      console.error("Error connecting transport:", error)
      callback({ error: error.message })
    }
  })

  socket.on("produce", async ({ transportId, kind, rtpParameters, appData }, callback) => {
    try {
      const peer = peers.get(socket.id)
      const transport = peer.transports.get(transportId)

      if (!transport) {
        throw new Error("Transport not found")
      }

      const producer = await transport.produce({
        kind,
        rtpParameters,
        appData: { ...appData, peerId: socket.id, email: peer.email },
      })

      peer.addProducer(producer)

      producer.on("transportclose", () => {
        producer.close()
      })

      callback({ id: producer.id })

      // Notify other peers about new producer
      const room = rooms.get(peer.roomId)
      if (room) {
        socket.to(peer.roomId).emit("new-producer", {
          producerId: producer.id,
          peerId: socket.id,
          email: peer.email,
          kind,
        })
      }
    } catch (error) {
      console.error("Error producing:", error)
      callback({ error: error.message })
    }
  })

  socket.on("consume", async ({ producerId, rtpCapabilities }, callback) => {
    try {
      const peer = peers.get(socket.id)

      if (!router.canConsume({ producerId, rtpCapabilities })) {
        callback({ error: "Cannot consume" })
        return
      }

      const transport = Array.from(peer.transports.values()).find((t) => t.appData?.consuming)

      if (!transport) {
        callback({ error: "No consuming transport found" })
        return
      }

      const consumer = await transport.consume({
        producerId,
        rtpCapabilities,
        paused: true,
      })

      peer.addConsumer(consumer)

      consumer.on("transportclose", () => {
        peer.removeConsumer(consumer.id)
      })

      consumer.on("producerclose", () => {
        peer.removeConsumer(consumer.id)
        socket.emit("consumer-closed", { consumerId: consumer.id })
      })

      callback({
        id: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
      })
    } catch (error) {
      console.error("Error consuming:", error)
      callback({ error: error.message })
    }
  })

  socket.on("resume-consumer", async ({ consumerId }, callback) => {
    try {
      const peer = peers.get(socket.id)
      const consumer = peer.consumers.get(consumerId)

      if (!consumer) {
        throw new Error("Consumer not found")
      }

      await consumer.resume()
      callback({ success: true })
    } catch (error) {
      console.error("Error resuming consumer:", error)
      callback({ error: error.message })
    }
  })

  socket.on("chat-message", ({ message, roomId }) => {
    const peer = peers.get(socket.id)
    if (peer) {
      io.to(roomId).emit("chat-message", {
        email: peer.email,
        message,
        timestamp: new Date().toISOString(),
      })
    }
  })

  socket.on("disconnect", () => {
    console.log("Socket disconnected:", socket.id)

    const peer = peers.get(socket.id)
    if (peer) {
      const room = rooms.get(peer.roomId)
      if (room) {
        room.removePeer(socket.id)
        socket.to(peer.roomId).emit("user-left", { id: socket.id })

        if (room.isEmpty()) {
          rooms.delete(peer.roomId)
        }
      }

      peer.close()
      peers.delete(socket.id)
    }
  })
})

// Initialize and start server
async function startServer() {
  try {
    await initializeMediasoup()

    const PORT = process.env.PORT || 3000
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on port ${PORT} (${process.env.NODE_ENV === "production" ? "HTTPS" : "HTTP"})`)
      console.log(`Announced IP: ${process.env.ANNOUNCED_IP || "127.0.0.1"}`)
    })
  } catch (error) {
    console.error("Failed to start server:", error)
    process.exit(1)
  }
}

startServer()

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("Shutting down server...")
  if (worker) {
    worker.close()
  }
  server.close(() => {
    console.log("Server closed")
    process.exit(0)
  })
})
