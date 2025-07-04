/* global io, mediasoupClient */
const io = window.io // Declare the io variable
const mediasoupClient = window.mediasoupClient // Declare the mediasoupClient variable

class MediasoupClient {
  constructor() {
    this.socket = io()
    this.device = null
    this.producerTransport = null
    this.consumerTransport = null
    this.producers = new Map()
    this.consumers = new Map()
    this.localStream = null
    this.isVideoEnabled = true
    this.isAudioEnabled = true
    this.isScreenSharing = false
    this.roomId = null
    this.email = null
    this.peers = new Map()
    this.unreadMessages = 0
    this.isRecording = false
    this.mediaRecorder = null
    this.recordedChunks = []

    this.setupSocketListeners()
  }

  async initialize(roomId, email) {
    this.roomId = roomId
    this.email = email

    try {
      // Get router capabilities
      const response = await fetch("/api/router-capabilities")
      const routerRtpCapabilities = await response.json()

      // Create device
      this.device = new mediasoupClient.Device()
      await this.device.load({ routerRtpCapabilities })

      // Get user media
      await this.getUserMedia()

      // Join room
      this.socket.emit("join-room", {
        roomId,
        email,
        rtpCapabilities: this.device.rtpCapabilities,
      })
    } catch (error) {
      console.error("Failed to initialize:", error)
      this.showError("Failed to initialize video call. Please check your camera and microphone permissions.")
    }
  }

  async getUserMedia() {
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })

      const localVideo = document.getElementById("local-video")
      localVideo.srcObject = this.localStream
      localVideo.muted = true

      this.addLocalVideoToSidebar()
    } catch (error) {
      console.error("Error accessing media devices:", error)
      throw new Error("Failed to access camera and microphone")
    }
  }

  setupSocketListeners() {
    this.socket.on("existing-peers", (peers) => {
      console.log("Existing peers:", peers)
      peers.forEach((peer) => {
        this.addPeerToUI(peer.id, peer.email)
      })
    })

    this.socket.on("user-joined", (peer) => {
      console.log("User joined:", peer)
      this.addPeerToUI(peer.id, peer.email)
    })

    this.socket.on("user-left", (peer) => {
      console.log("User left:", peer)
      this.removePeerFromUI(peer.id)
    })

    this.socket.on("new-producer", async ({ producerId, peerId, email, kind }) => {
      console.log("New producer:", { producerId, peerId, kind })
      await this.consume(producerId, peerId, kind)
    })

    this.socket.on("consumer-closed", ({ consumerId }) => {
      console.log("Consumer closed:", consumerId)
      const consumer = this.consumers.get(consumerId)
      if (consumer) {
        consumer.close()
        this.consumers.delete(consumerId)
      }
    })

    this.socket.on("chat-message", ({ email, message, timestamp }) => {
      this.addChatMessage(email, message, timestamp)
    })

    this.socket.on("error", ({ message }) => {
      this.showError(message)
    })
  }

  async createTransports() {
    // Create producer transport
    this.producerTransport = await this.createTransport("send")

    // Create consumer transport
    this.consumerTransport = await this.createTransport("recv")
  }

  async createTransport(direction) {
    return new Promise((resolve, reject) => {
      this.socket.emit("create-transport", { direction, roomId: this.roomId }, async (data) => {
        if (data.error) {
          reject(new Error(data.error))
          return
        }

        let transport
        if (direction === "send") {
          transport = this.device.createSendTransport(data)
        } else {
          transport = this.device.createRecvTransport(data)
        }

        transport.on("connect", async ({ dtlsParameters }, callback, errback) => {
          try {
            this.socket.emit(
              "connect-transport",
              {
                transportId: transport.id,
                dtlsParameters,
              },
              (response) => {
                if (response.error) {
                  errback(new Error(response.error))
                } else {
                  callback()
                }
              },
            )
          } catch (error) {
            errback(error)
          }
        })

        if (direction === "send") {
          transport.on("produce", async ({ kind, rtpParameters, appData }, callback, errback) => {
            try {
              this.socket.emit(
                "produce",
                {
                  transportId: transport.id,
                  kind,
                  rtpParameters,
                  appData,
                },
                (response) => {
                  if (response.error) {
                    errback(new Error(response.error))
                  } else {
                    callback({ id: response.id })
                  }
                },
              )
            } catch (error) {
              errback(error)
            }
          })
        }

        resolve(transport)
      })
    })
  }

  async startProducing() {
    if (!this.producerTransport) {
      await this.createTransports()
    }

    // Produce video
    if (this.localStream.getVideoTracks().length > 0) {
      const videoTrack = this.localStream.getVideoTracks()[0]
      const videoProducer = await this.producerTransport.produce({
        track: videoTrack,
        encodings: [{ maxBitrate: 100000 }, { maxBitrate: 300000 }, { maxBitrate: 900000 }],
        codecOptions: {
          videoGoogleStartBitrate: 1000,
        },
      })

      this.producers.set("video", videoProducer)

      videoProducer.on("trackended", () => {
        console.log("Video track ended")
      })
    }

    // Produce audio
    if (this.localStream.getAudioTracks().length > 0) {
      const audioTrack = this.localStream.getAudioTracks()[0]
      const audioProducer = await this.producerTransport.produce({
        track: audioTrack,
      })

      this.producers.set("audio", audioProducer)

      audioProducer.on("trackended", () => {
        console.log("Audio track ended")
      })
    }
  }

  async consume(producerId, peerId, kind) {
    if (!this.consumerTransport) {
      await this.createTransports()
    }

    this.socket.emit(
      "consume",
      {
        producerId,
        rtpCapabilities: this.device.rtpCapabilities,
      },
      async (data) => {
        if (data.error) {
          console.error("Consume error:", data.error)
          return
        }

        const consumer = await this.consumerTransport.consume({
          id: data.id,
          producerId: data.producerId,
          kind: data.kind,
          rtpParameters: data.rtpParameters,
        })

        this.consumers.set(consumer.id, consumer)

        // Resume consumer
        this.socket.emit("resume-consumer", { consumerId: consumer.id }, (response) => {
          if (response.error) {
            console.error("Resume consumer error:", response.error)
          }
        })

        // Add track to peer video
        this.addTrackToPeer(peerId, consumer.track, kind)
      },
    )
  }

  addTrackToPeer(peerId, track, kind) {
    let peer = this.peers.get(peerId)
    if (!peer) {
      peer = { stream: new MediaStream(), video: null, audio: null }
      this.peers.set(peerId, peer)
    }

    peer.stream.addTrack(track)
    peer[kind] = track

    const videoElement = document.getElementById(`video-${peerId}`)
    if (videoElement) {
      videoElement.srcObject = peer.stream
    }
  }

  addPeerToUI(peerId, email) {
    if (document.getElementById(`container-${peerId}`)) {
      return // Already exists
    }

    const videoContainer = document.createElement("div")
    videoContainer.className = "video-container"
    videoContainer.id = `container-${peerId}`
    videoContainer.innerHTML = `
      <video id="video-${peerId}" autoplay playsinline></video>
      <div class="participant-info">
        <span class="participant-name">${email}</span>
        <div class="participant-status">
          <i class="fas fa-microphone" id="mic-${peerId}"></i>
          <i class="fas fa-video" id="cam-${peerId}"></i>
        </div>
      </div>
    `

    videoContainer.onclick = () => this.switchMainVideo(peerId)
    document.getElementById("participants").appendChild(videoContainer)
  }

  removePeerFromUI(peerId) {
    const container = document.getElementById(`container-${peerId}`)
    if (container) {
      container.remove()
    }
    this.peers.delete(peerId)
  }

  addLocalVideoToSidebar() {
    const localContainer = document.createElement("div")
    localContainer.className = "video-container local-video"
    localContainer.id = "container-local"
    localContainer.innerHTML = `
      <video id="video-local" autoplay playsinline muted></video>
      <div class="participant-info">
        <span class="participant-name">${this.email} (You)</span>
        <div class="participant-status">
          <i class="fas fa-microphone" id="mic-local"></i>
          <i class="fas fa-video" id="cam-local"></i>
        </div>
      </div>
    `

    const localVideo = localContainer.querySelector("#video-local")
    localVideo.srcObject = this.localStream

    localContainer.onclick = () => this.switchMainVideo("local")

    const participants = document.getElementById("participants")
    participants.insertBefore(localContainer, participants.firstChild)
  }

  switchMainVideo(peerId) {
    const mainVideo = document.getElementById("local-video")

    // Update selected state
    document.querySelectorAll(".video-container").forEach((container) => {
      container.classList.remove("selected")
    })

    const selectedContainer = document.getElementById(`container-${peerId}`)
    if (selectedContainer) {
      selectedContainer.classList.add("selected")
    }

    // Switch main video source
    if (peerId === "local") {
      mainVideo.srcObject = this.localStream
      mainVideo.muted = true
    } else {
      const peer = this.peers.get(peerId)
      if (peer && peer.stream) {
        mainVideo.srcObject = peer.stream
        mainVideo.muted = false
      }
    }
  }

  async toggleVideo() {
    this.isVideoEnabled = !this.isVideoEnabled

    const videoTrack = this.localStream.getVideoTracks()[0]
    if (videoTrack) {
      videoTrack.enabled = this.isVideoEnabled
    }

    const videoBtn = document.getElementById("video-btn")
    const icon = videoBtn.querySelector("i")

    if (this.isVideoEnabled) {
      videoBtn.classList.remove("off")
      icon.className = "fas fa-video"
    } else {
      videoBtn.classList.add("off")
      icon.className = "fas fa-video-slash"
    }

    // Update local video display
    this.updateLocalVideoStatus()
  }

  async toggleAudio() {
    this.isAudioEnabled = !this.isAudioEnabled

    const audioTrack = this.localStream.getAudioTracks()[0]
    if (audioTrack) {
      audioTrack.enabled = this.isAudioEnabled
    }

    const audioBtn = document.getElementById("audio-btn")
    const icon = audioBtn.querySelector("i")

    if (this.isAudioEnabled) {
      audioBtn.classList.remove("off")
      icon.className = "fas fa-microphone"
    } else {
      audioBtn.classList.add("off")
      icon.className = "fas fa-microphone-slash"
    }

    // Update local audio display
    this.updateLocalAudioStatus()
  }

  updateLocalVideoStatus() {
    const camIcon = document.getElementById("cam-local")
    if (camIcon) {
      camIcon.className = this.isVideoEnabled ? "fas fa-video" : "fas fa-video-slash"
      camIcon.style.color = this.isVideoEnabled ? "#4caf50" : "#f44336"
    }
  }

  updateLocalAudioStatus() {
    const micIcon = document.getElementById("mic-local")
    if (micIcon) {
      micIcon.className = this.isAudioEnabled ? "fas fa-microphone" : "fas fa-microphone-slash"
      micIcon.style.color = this.isAudioEnabled ? "#4caf50" : "#f44336"
    }
  }

  async shareScreen() {
    const screenBtn = document.getElementById("screen-btn")
    const icon = screenBtn.querySelector("i")

    if (!this.isScreenSharing) {
      try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            frameRate: { ideal: 30 },
          },
          audio: true,
        })

        const videoTrack = screenStream.getVideoTracks()[0]

        // Replace video track in producer
        const videoProducer = this.producers.get("video")
        if (videoProducer) {
          await videoProducer.replaceTrack({ track: videoTrack })
        }

        // Update local video
        const localVideo = document.getElementById("local-video")
        const newStream = new MediaStream([videoTrack, ...this.localStream.getAudioTracks()])
        localVideo.srcObject = newStream

        videoTrack.onended = () => {
          this.stopScreenShare()
        }

        this.isScreenSharing = true
        screenBtn.classList.add("active")
        icon.className = "fas fa-stop"
      } catch (error) {
        console.error("Error sharing screen:", error)
      }
    } else {
      this.stopScreenShare()
    }
  }

  async stopScreenShare() {
    const videoTrack = this.localStream.getVideoTracks()[0]

    // Replace back to camera
    const videoProducer = this.producers.get("video")
    if (videoProducer && videoTrack) {
      await videoProducer.replaceTrack({ track: videoTrack })
    }

    // Update local video
    const localVideo = document.getElementById("local-video")
    localVideo.srcObject = this.localStream

    this.isScreenSharing = false
    const screenBtn = document.getElementById("screen-btn")
    const icon = screenBtn.querySelector("i")
    screenBtn.classList.remove("active")
    icon.className = "fas fa-desktop"
  }

  toggleRecording() {
    if (!this.isRecording) {
      this.startRecording()
    } else {
      this.stopRecording()
    }
  }

  startRecording() {
    const canvas = document.createElement("canvas")
    const ctx = canvas.getContext("2d")
    canvas.width = 1920
    canvas.height = 1080

    const mainVideo = document.getElementById("local-video")
    const participantVideos = Array.from(document.querySelectorAll("#participants video"))

    const draw = () => {
      if (!this.isRecording) return

      // Clear canvas
      ctx.fillStyle = "#000"
      ctx.fillRect(0, 0, canvas.width, canvas.height)

      // Draw main video
      if (mainVideo.videoWidth > 0) {
        ctx.drawImage(mainVideo, 0, 0, canvas.width * 0.75, canvas.height)
      }

      // Draw participant videos
      const sidebarWidth = canvas.width * 0.25
      const videoHeight = canvas.height / Math.max(participantVideos.length, 1)

      participantVideos.forEach((video, index) => {
        if (video.videoWidth > 0) {
          ctx.drawImage(video, canvas.width * 0.75, index * videoHeight, sidebarWidth, videoHeight)
        }
      })

      requestAnimationFrame(draw)
    }

    const canvasStream = canvas.captureStream(30)
    this.mediaRecorder = new MediaRecorder(canvasStream, {
      mimeType: "video/webm;codecs=vp9",
    })

    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        this.recordedChunks.push(event.data)
      }
    }

    this.mediaRecorder.onstop = () => {
      const blob = new Blob(this.recordedChunks, { type: "video/webm" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `meeting-recording-${new Date().toISOString()}.webm`
      a.click()
      URL.revokeObjectURL(url)
      this.recordedChunks = []
    }

    this.mediaRecorder.start()
    this.isRecording = true

    const recordBtn = document.getElementById("record-btn")
    recordBtn.classList.add("recording")

    draw()
  }

  stopRecording() {
    if (this.mediaRecorder && this.isRecording) {
      this.mediaRecorder.stop()
      this.isRecording = false

      const recordBtn = document.getElementById("record-btn")
      recordBtn.classList.remove("recording")
    }
  }

  sendMessage() {
    const input = document.getElementById("chat-input")
    const message = input.value.trim()

    if (message) {
      this.socket.emit("chat-message", { message, roomId: this.roomId })
      input.value = ""
    }
  }

  addChatMessage(email, message, timestamp) {
    const chatContainer = document.getElementById("chat-container")
    const chatPanel = document.getElementById("chat-panel")
    const chatBadge = document.getElementById("chat-badge")

    const messageElement = document.createElement("div")
    messageElement.className = "chat-message"
    messageElement.innerHTML = `
      <div class="message-header">
        <span class="sender">${email}</span>
        <span class="timestamp">${new Date(timestamp).toLocaleTimeString()}</span>
      </div>
      <div class="message-content">${message}</div>
    `

    chatContainer.appendChild(messageElement)
    chatContainer.scrollTop = chatContainer.scrollHeight

    if (!chatPanel.classList.contains("active")) {
      this.unreadMessages++
      chatBadge.textContent = this.unreadMessages
      chatBadge.parentElement.classList.add("has-messages")
    }
  }

  toggleChat() {
    const chatPanel = document.getElementById("chat-panel")
    const chatBadge = document.getElementById("chat-badge")

    chatPanel.classList.toggle("active")

    if (chatPanel.classList.contains("active")) {
      this.unreadMessages = 0
      chatBadge.textContent = "0"
      chatBadge.parentElement.classList.remove("has-messages")
    }
  }

  hangup() {
    // Close all producers and consumers
    this.producers.forEach((producer) => producer.close())
    this.consumers.forEach((consumer) => consumer.close())

    // Close transports
    if (this.producerTransport) this.producerTransport.close()
    if (this.consumerTransport) this.consumerTransport.close()

    // Stop local stream
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop())
    }

    // Disconnect socket
    this.socket.disconnect()

    // Redirect to home
    window.location.href = "/"
  }

  showError(message) {
    const errorDiv = document.createElement("div")
    errorDiv.className = "error-notification"
    errorDiv.textContent = message
    document.body.appendChild(errorDiv)

    setTimeout(() => {
      errorDiv.remove()
    }, 5000)
  }
}

// Global client instance
let client

// Global functions for UI
async function startMeeting(roomId, email) {
  client = new MediasoupClient()
  await client.initialize(roomId, email)
  await client.startProducing()
}

function toggleVideo() {
  if (client) client.toggleVideo()
}

function toggleAudio() {
  if (client) client.toggleAudio()
}

function shareScreen() {
  if (client) client.shareScreen()
}

function toggleRecording() {
  if (client) client.toggleRecording()
}

function sendMessage() {
  if (client) client.sendMessage()
}

function toggleChat() {
  if (client) client.toggleChat()
}

function hangup() {
  if (client) client.hangup()
}
