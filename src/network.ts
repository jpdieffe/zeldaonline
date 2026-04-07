import Peer from 'peerjs'
import type { DataConnection } from 'peerjs'
import type { NetMessage, PlayerState, EnemyNetState } from './types'

const PEER_SERVER = {
  host: '0.peerjs.com',
  port: 443,
  path: '/',
  secure: true,
  config: {
    iceServers: [
      { urls: 'stun:stun.relay.metered.ca:80' },
      { urls: 'turn:standard.relay.metered.ca:80', username: '1149240b8a0d6b7c28fe6c30', credential: 'D/2XqOd5kT9ew842' },
      { urls: 'turn:standard.relay.metered.ca:80?transport=tcp', username: '1149240b8a0d6b7c28fe6c30', credential: 'D/2XqOd5kT9ew842' },
      { urls: 'turn:standard.relay.metered.ca:443', username: '1149240b8a0d6b7c28fe6c30', credential: 'D/2XqOd5kT9ew842' },
      { urls: 'turns:standard.relay.metered.ca:443?transport=tcp', username: '1149240b8a0d6b7c28fe6c30', credential: 'D/2XqOd5kT9ew842' },
    ]
  }
}

const FRUITS = [
  'apple','apricot','avocado','banana','berry','cherry','clementine',
  'coconut','fig','grape','guava','kiwi','lemon','lime','lychee',
  'mango','melon','nectarine','olive','orange','papaya','peach',
  'pear','pineapple','plum','pomelo','quince','raspberry','starfruit',
  'strawberry','tangerine','watermelon',
]

function fruitId(): string {
  const fruit = FRUITS[Math.floor(Math.random() * FRUITS.length)]
  const num   = Math.floor(Math.random() * 90) + 10
  return `zelda-${fruit}-${num}`
}

export class Network {
  private peer: Peer | null = null
  private conn: DataConnection | null = null
  private roomId: string | null = null
  private gameStarted = false
  private keepaliveId: ReturnType<typeof setInterval> | null = null
  private lastPong = 0
  private reconnecting = false

  lastRemoteState: PlayerState | null = null
  isHost = false

  onPeerConnected: (() => void) | null = null
  onPeerDisconnected: (() => void) | null = null
  onError: ((msg: string) => void) | null = null
  onStatus: ((msg: string) => void) | null = null
  onGroundItem: ((itemId: string, x: number, y: number, z: number) => void) | null = null
  onSpell: ((spell: string, x: number, y: number, z: number, dx: number, dy: number, dz: number, damage?: number) => void) | null = null

  static generateRoomCode(): string { return fruitId() }

  /** Mark that the game has started — errors after this are handled more gracefully */
  markGameStarted() { this.gameStarted = true }

  host(onReady: (roomId: string) => void, roomCode?: string) {
    this.destroy()
    this.isHost = true
    const id = roomCode ?? fruitId()
    this.roomId = id
    this.peer = new Peer(id, PEER_SERVER)

    const timeout = setTimeout(() => {
      this.onError?.('Could not reach PeerJS server.')
    }, 12000)

    this.peer.on('open', pid => {
      clearTimeout(timeout)
      console.log('[Network] HOST registered as:', pid)
      onReady(pid)
    })

    this.peer.on('disconnected', () => {
      console.warn('[Network] Host signaling disconnected, reconnecting…')
      if (this.peer && !this.peer.destroyed) this.peer.reconnect()
    })

    this.peer.on('connection', conn => {
      console.log('[Network] Peer connected')
      this.conn = conn
      this.wireConn(conn)
      conn.on('open', () => {
        this.startKeepalive()
        this.onPeerConnected?.()
      })
    })

    this.peer.on('error', err => {
      clearTimeout(timeout)
      const msg = (err as Error).message ?? String(err)
      console.error('[Network] Host error:', msg)
      if (this.gameStarted) {
        // Don't block the game with a full-screen overlay for transient errors
        console.warn('[Network] Ignoring post-game error, will rely on keepalive')
      } else {
        this.onError?.(`Connection error: ${msg}`)
      }
    })
  }

  join(roomId: string, onConnected: () => void) {
    this.destroy()
    this.isHost = false
    this.roomId = roomId
    this.peer = new Peer(PEER_SERVER as any)

    const timeout = setTimeout(() => {
      this.onError?.('Could not reach PeerJS server.')
    }, 12000)

    this.peer.on('open', (_id) => {
      clearTimeout(timeout)
      this.openConn(roomId, onConnected)
    })

    this.peer.on('disconnected', () => {
      console.warn('[Network] Joiner signaling disconnected, reconnecting…')
      if (this.peer && !this.peer.destroyed) this.peer.reconnect()
    })

    this.peer.on('error', err => {
      clearTimeout(timeout)
      const msg = (err as Error).message ?? String(err)
      console.error('[Network] Joiner error:', msg)
      if (this.gameStarted) {
        console.warn('[Network] Ignoring post-game error, will rely on keepalive')
      } else {
        this.onError?.(`Connection error: ${msg}`)
      }
    })
  }

  private openConn(roomId: string, onConnected: () => void) {
    if (!this.peer || this.peer.destroyed) return
    const conn = this.peer.connect(roomId, { reliable: true })
    this.conn = conn
    this.wireConn(conn)

    const connTimeout = setTimeout(() => {
      if (!conn.open) this.onError?.('Could not connect to that room code.')
    }, 15000)

    conn.on('open', () => {
      clearTimeout(connTimeout)
      this.startKeepalive()
      onConnected()
      this.onPeerConnected?.()
    })
  }

  private wireConn(conn: DataConnection) {
    conn.on('data', raw => {
      const msg = raw as NetMessage
      if (msg.type === 'state') {
        this.lastRemoteState = msg.state
      } else if (msg.type === 'enemies') {
        this.lastEnemyStates = msg.enemies
        this.enemyStatesVersion++
      } else if (msg.type === 'ping') {
        // Reply with pong
        if (this.conn?.open) this.conn.send({ type: 'pong' })
      } else if (msg.type === 'pong') {
        this.lastPong = Date.now()
      } else if (msg.type === 'groundItem') {
        this.onGroundItem?.(msg.itemId, msg.x, msg.y, msg.z)
      } else if (msg.type === 'spell') {
        this.onSpell?.(msg.spell, msg.x, msg.y, msg.z, msg.dx, msg.dy, msg.dz, msg.damage)
      }
    })
    conn.on('close', () => {
      console.warn('[Network] Data connection closed')
      this.conn = null
      this.stopKeepalive()
      if (this.gameStarted) {
        this.onPeerDisconnected?.()
        this.attemptReconnect()
      }
    })
    conn.on('error', err => {
      console.error('[Network] conn error', err)
    })
  }

  private startKeepalive() {
    this.stopKeepalive()
    this.lastPong = Date.now()
    this.keepaliveId = setInterval(() => {
      if (this.conn?.open) {
        this.conn.send({ type: 'ping' })
        // If no pong received in 15 seconds, consider connection dead
        if (Date.now() - this.lastPong > 15000) {
          console.warn('[Network] Keepalive timeout — closing stale connection')
          this.conn.close()
        }
      }
    }, 5000)
  }

  private stopKeepalive() {
    if (this.keepaliveId !== null) {
      clearInterval(this.keepaliveId)
      this.keepaliveId = null
    }
  }

  private attemptReconnect() {
    if (this.reconnecting || !this.roomId) return
    this.reconnecting = true
    console.log('[Network] Attempting reconnect…')
    this.onStatus?.('Connection lost — reconnecting…')

    // Ensure signaling is alive
    if (this.peer && !this.peer.destroyed && this.peer.disconnected) {
      this.peer.reconnect()
    }

    let attempts = 0
    const maxAttempts = 6
    const tryConnect = () => {
      attempts++
      if (attempts > maxAttempts || !this.peer || this.peer.destroyed) {
        this.reconnecting = false
        this.onError?.('Lost connection to peer.')
        return
      }

      if (this.isHost) {
        // Host waits for the joiner to reconnect to them
        console.log(`[Network] Host waiting for reconnect (attempt ${attempts}/${maxAttempts})…`)
        setTimeout(() => {
          if (this.conn?.open) {
            // Joiner reconnected via peer.on('connection')
            this.reconnecting = false
            this.onStatus?.('')
            return
          }
          tryConnect()
        }, 5000)
      } else {
        // Joiner actively reconnects to host
        console.log(`[Network] Joiner reconnecting (attempt ${attempts}/${maxAttempts})…`)
        if (!this.peer || this.peer.destroyed) { this.reconnecting = false; return }
        const conn = this.peer.connect(this.roomId!, { reliable: true })
        this.conn = conn
        this.wireConn(conn)

        const connTimeout = setTimeout(() => {
          if (!conn.open) tryConnect()
        }, 8000)

        conn.on('open', () => {
          clearTimeout(connTimeout)
          this.reconnecting = false
          this.startKeepalive()
          this.onStatus?.('')
          this.onPeerConnected?.()
          console.log('[Network] Reconnected!')
        })
      }
    }

    // Wait a moment before first attempt
    setTimeout(tryConnect, 2000)
  }

  sendPosition(state: PlayerState) {
    if (this.conn?.open) {
      const msg: NetMessage = { type: 'state', state }
      this.conn.send(msg)
    }
  }

  sendEnemies(enemies: EnemyNetState[]) {
    if (this.conn?.open) {
      const msg: NetMessage = { type: 'enemies', enemies }
      this.conn.send(msg)
    }
  }

  send(msg: NetMessage) {
    if (this.conn?.open) this.conn.send(msg)
  }

  lastEnemyStates: EnemyNetState[] | null = null
  enemyStatesVersion = 0

  isConnected(): boolean {
    return this.conn?.open ?? false
  }

  ensureSignaling() {
    if (this.peer && !this.peer.destroyed && this.peer.disconnected) {
      this.peer.reconnect()
    }
  }

  destroy() {
    this.stopKeepalive()
    this.reconnecting = false
    this.peer?.destroy()
  }
}
