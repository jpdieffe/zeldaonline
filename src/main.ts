import {
  Engine,
  Scene,
  Vector3,
  HemisphericLight,
  DirectionalLight,
  Color4,
  Color3,
  MeshBuilder,
  StandardMaterial,
} from '@babylonjs/core'
import { Player } from './player'
import { Network } from './network'
import { RemotePlayer } from './remote'

const canvas = document.getElementById('renderCanvas') as HTMLCanvasElement
const network = new Network()

// ── Status overlay ───────────────────────────────────────────────────────────
function showStatus(msg: string, isError = false) {
  let el = document.getElementById('_gameStatus')
  if (!el) {
    el = document.createElement('div')
    el.id = '_gameStatus'
    el.style.cssText = [
      'position:fixed', 'top:50%', 'left:50%',
      'transform:translate(-50%,-50%)',
      'background:rgba(0,10,40,0.93)',
      'padding:1.2rem 2rem',
      'font:0.95rem/1.5 system-ui,sans-serif',
      'z-index:999', 'border-radius:10px',
      'max-width:80%', 'text-align:center',
      'white-space:pre-wrap', 'border:1px solid #446',
    ].join(';')
    document.body.appendChild(el)
  }
  el.style.color = isError ? '#f88' : '#cdf'
  el.textContent = msg
}
function hideStatus() {
  document.getElementById('_gameStatus')?.remove()
}

// ── Lobby UI ─────────────────────────────────────────────────────────────────
const lobby = document.getElementById('lobby')!
const soloBtn = document.getElementById('soloBtn') as HTMLButtonElement
const hostBtn = document.getElementById('hostBtn') as HTMLButtonElement
const joinBtn = document.getElementById('joinBtn') as HTMLButtonElement
const joinInput = document.getElementById('joinInput') as HTMLInputElement
const roomDisplay = document.getElementById('roomDisplay')!

function hideLobby() { lobby.style.display = 'none' }

soloBtn.addEventListener('click', () => { hideLobby(); startGame() })

hostBtn.addEventListener('click', () => {
  hostBtn.disabled = true
  showStatus('Creating room…')
  network.host((roomId) => {
    hideStatus()
    roomDisplay.textContent = `Room: ${roomId}`
    roomDisplay.style.display = 'block'
    hideLobby()
    startGame()
  })
  network.onPeerConnected = () => {
    if (!remote) {
      remote = new RemotePlayer(scene!)
    }
  }
  network.onError = (msg) => showStatus(msg, true)
})

joinBtn.addEventListener('click', () => {
  const code = joinInput.value.trim()
  if (!code) return
  joinBtn.disabled = true
  showStatus('Joining…')
  network.join(code, () => {
    hideStatus()
    hideLobby()
    startGame()
    if (!remote) {
      remote = new RemotePlayer(scene!)
    }
  })
  network.onError = (msg) => { showStatus(msg, true); joinBtn.disabled = false }
})

// ── Game ─────────────────────────────────────────────────────────────────────
let scene: Scene | null = null
let remote: RemotePlayer | null = null

function startGame() {
  // WebGL check
  const testCanvas = document.createElement('canvas')
  testCanvas.width = 100; testCanvas.height = 100
  const testCtx = testCanvas.getContext('webgl2') ?? testCanvas.getContext('webgl')
  if (!testCtx) {
    showStatus('WebGL not available — enable hardware acceleration in your browser.', true)
    return
  }

  let engine: Engine | undefined
  for (const noWebGL2 of [false, true]) {
    try {
      engine = new Engine(canvas, true, {
        preserveDrawingBuffer: true,
        stencil: true,
        disableWebGL2Support: noWebGL2,
      })
      break
    } catch { /* try next */ }
  }
  if (!engine) { showStatus('Failed to start graphics engine.', true); return }

  scene = new Scene(engine)
  scene.clearColor = new Color4(0.55, 0.78, 0.96, 1.0)

  // Fog
  scene.fogMode = Scene.FOGMODE_EXP2
  scene.fogColor = new Color3(0.55, 0.78, 0.96)
  scene.fogDensity = 0.004

  // Lights
  const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene)
  hemi.intensity = 0.6
  const sun = new DirectionalLight('sun', new Vector3(-1, -2, -1), scene)
  sun.intensity = 0.9

  // Ground
  const ground = MeshBuilder.CreateGround('ground', { width: 200, height: 200 }, scene)
  const groundMat = new StandardMaterial('groundMat', scene)
  groundMat.diffuseColor = new Color3(0.35, 0.6, 0.25)
  groundMat.specularColor = new Color3(0.05, 0.05, 0.05)
  ground.material = groundMat

  // Water plane (slightly below ground)
  const water = MeshBuilder.CreateGround('water', { width: 500, height: 500 }, scene)
  water.position.y = -0.4
  const waterMat = new StandardMaterial('waterMat', scene)
  waterMat.diffuseColor = new Color3(0.15, 0.35, 0.7)
  waterMat.specularColor = new Color3(0.3, 0.3, 0.5)
  waterMat.alpha = 0.55
  water.material = waterMat

  // Player
  const player = new Player(scene)

  // Network send
  const SEND_INTERVAL = 1 / 20
  let sendTimer = 0

  // Render loop
  engine.runRenderLoop(() => {
    const dt = Math.min(engine!.getDeltaTime() / 1000, 0.05)

    player.update(dt)

    // Send state to peer
    sendTimer += dt
    if (sendTimer >= SEND_INTERVAL && network.isConnected()) {
      sendTimer = 0
      network.sendPosition(player.getState())
    }

    // Apply remote state
    if (remote && network.lastRemoteState) {
      remote.applyState(network.lastRemoteState)
      remote.update(dt)
    }

    scene!.render()
  })

  window.addEventListener('resize', () => engine!.resize())
}
