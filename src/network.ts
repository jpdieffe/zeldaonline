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

  lastRemoteState: PlayerState | null = null
  isHost = false

  onPeerConnected: (() => void) | null = null
  onError: ((msg: string) => void) | null = null
  onStatus: ((msg: string) => void) | null = null

  static generateRoomCode(): string { return fruitId() }

  host(onReady: (roomId: string) => void, roomCode?: string) {
    this.destroy()
    this.isHost = true
    this.peer = new Peer(roomCode ?? fruitId(), PEER_SERVER)

    const timeout = setTimeout(() => {
      this.onError?.('Could not reach PeerJS server.')
    }, 12000)

    this.peer.on('open', id => {
      clearTimeout(timeout)
      console.log('[Network] HOST registered as:', id)
      onReady(id)
    })

    this.peer.on('disconnected', () => {
      if (this.peer && !this.peer.destroyed) this.peer.reconnect()
    })

    this.peer.on('connection', conn => {
      this.conn = conn
      this.wireConn(conn)
      conn.on('open', () => { this.onPeerConnected?.() })
    })

    this.peer.on('error', err => {
      clearTimeout(timeout)
      this.onError?.(`Connection error: ${(err as Error).message ?? err}`)
    })
  }

  join(roomId: string, onConnected: () => void) {
    this.destroy()
    this.isHost = false
    this.peer = new Peer(PEER_SERVER as any)

    const timeout = setTimeout(() => {
      this.onError?.('Could not reach PeerJS server.')
    }, 12000)

    this.peer.on('open', (_id) => {
      clearTimeout(timeout)
      const conn = this.peer!.connect(roomId, { reliable: true })
      this.conn = conn
      this.wireConn(conn)

      const connTimeout = setTimeout(() => {
        this.onError?.('Could not connect to that room code.')
      }, 15000)

      conn.on('open', () => {
        clearTimeout(connTimeout)
        onConnected()
        this.onPeerConnected?.()
      })
    })

    this.peer.on('error', err => {
      clearTimeout(timeout)
      this.onError?.(`Connection error: ${(err as Error).message ?? err}`)
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
      }
    })
    conn.on('close', () => { this.conn = null })
    conn.on('error', err => console.error('[Network] conn error', err))
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
    this.peer?.destroy()
  }
}
