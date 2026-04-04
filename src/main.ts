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
  GroundMesh,
  VertexBuffer,
} from '@babylonjs/core'
import { Player } from './player'
import { Network } from './network'
import { RemotePlayer } from './remote'
import { EnemyManager, Enemy } from './enemy'
import { Structures } from './structures'
import { loadLevelData } from './level'

const canvas = document.getElementById('renderCanvas') as HTMLCanvasElement
const network = new Network()

// Simple value noise for terrain hills
function hash(x: number, z: number): number {
  let n = Math.sin(x * 127.1 + z * 311.7) * 43758.5453
  return n - Math.floor(n)
}
function smoothNoise(x: number, z: number): number {
  const ix = Math.floor(x), iz = Math.floor(z)
  const fx = x - ix, fz = z - iz
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz)
  const a = hash(ix, iz), b = hash(ix + 1, iz)
  const c = hash(ix, iz + 1), d = hash(ix + 1, iz + 1)
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz
}
function hillNoise(x: number, z: number): number {
  let h = 0
  h += smoothNoise(x * 0.02, z * 0.02) * 6    // broad hills
  h += smoothNoise(x * 0.06, z * 0.06) * 2     // medium bumps
  h += smoothNoise(x * 0.15, z * 0.15) * 0.5   // small detail
  return h - 3   // shift down so some areas are below water
}

/** Query terrain height at any (x,z) — exported for player use */
export { hillNoise }

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

let gameRoomCode: string | undefined

hostBtn.addEventListener('click', () => {
  hostBtn.disabled = true
  showStatus('Creating room…')
  network.host((roomId) => {
    hideStatus()
    roomDisplay.textContent = `Room: ${roomId}`
    roomDisplay.style.display = 'block'
    hideLobby()
    gameRoomCode = roomId
    startGame(roomId)
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
    gameRoomCode = code
    startGame(code)
    if (!remote) {
      remote = new RemotePlayer(scene!)
    }
  })
  network.onError = (msg) => { showStatus(msg, true); joinBtn.disabled = false }
})

// ── Game ─────────────────────────────────────────────────────────────────────
let scene: Scene | null = null
let remote: RemotePlayer | null = null

async function startGame(seed?: string) {
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

  // Ground with hills
  const GROUND_SIZE = 200
  const SUBDIVISIONS = 128
  const ground = MeshBuilder.CreateGround('ground', {
    width: GROUND_SIZE, height: GROUND_SIZE,
    subdivisions: SUBDIVISIONS, updatable: true,
  }, scene) as GroundMesh
  const groundMat = new StandardMaterial('groundMat', scene)
  groundMat.diffuseColor = new Color3(0.35, 0.6, 0.25)
  groundMat.specularColor = new Color3(0.05, 0.05, 0.05)
  ground.material = groundMat

  // Try loading a custom level (from level builder)
  const levelData = await loadLevelData()

  // Apply heights: custom heightmap or procedural noise
  const positions = ground.getVerticesData(VertexBuffer.PositionKind)!
  if (levelData) {
    const GRID = SUBDIVISIONS + 1
    const CELL_WORLD = GROUND_SIZE / SUBDIVISIONS
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i]
      const z = positions[i + 2]
      // Convert world coords → grid index
      const gx = Math.round((x + GROUND_SIZE / 2) / CELL_WORLD)
      const gz = Math.round((z + GROUND_SIZE / 2) / CELL_WORLD)
      const cgx = Math.max(0, Math.min(GRID - 1, gx))
      const cgz = Math.max(0, Math.min(GRID - 1, gz))
      positions[i + 1] = levelData.heightmap[cgz]?.[cgx] ?? 0
    }
  } else {
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i]
      const z = positions[i + 2]
      positions[i + 1] = hillNoise(x, z)
    }
  }
  ground.updateVerticesData(VertexBuffer.PositionKind, positions)
  ground.createNormals(false)
  // Enable height queries
  ground._heightQuads = null as any  // force recalc
  ground.updateCoordinateHeights()

  // Water plane (slightly below ground)
  const water = MeshBuilder.CreateGround('water', { width: 500, height: 500 }, scene)
  water.position.y = levelData?.waterY ?? -0.4
  const waterMat = new StandardMaterial('waterMat', scene)
  waterMat.diffuseColor = new Color3(0.15, 0.35, 0.7)
  waterMat.specularColor = new Color3(0.3, 0.3, 0.5)
  waterMat.alpha = 0.55
  water.material = waterMat

  // Player
  const player = new Player(scene, ground)

  // Structures + Enemies — from level data or procedural
  const structures = new Structures(scene, ground, levelData ? 0 : 6, seed)

  if (levelData) {
    // Place structures from level data
    let cabinId = 0, fireId = 0, towerId = 0
    for (const obj of levelData.objects) {
      const gy = ground.getHeightAtCoordinates(obj.wx, obj.wz) ?? 0
      if (obj.type === 'cabin') {
        structures.buildCabin(obj.wx, gy, obj.wz, 0, cabinId++)
      } else if (obj.type === 'campfire') {
        structures.buildCampfire(obj.wx, gy, obj.wz, fireId++)
      } else if (obj.type === 'tower') {
        structures.buildTower(obj.wx, gy, obj.wz, towerId++)
      }
    }

    // Draw roads on terrain (flatten ground along road and tint later)
    for (const road of levelData.roads) {
      for (const [wx, wz] of road) {
        // Flatten road area by smoothing neighbors toward this height
        const roadY = ground.getHeightAtCoordinates(wx, wz) ?? 0
        // Apply as slight flatten in the vertex buffer (already applied above)
        void roadY // roads stored for future visual overlay
      }
    }
  }

  player.setCollidableMeshes(structures.collidable)
  player.setWallCollider((pos) => structures.resolveCollision(pos))

  // Enemies
  let enemyMgr: EnemyManager
  if (levelData) {
    enemyMgr = new EnemyManager(scene, ground, 0, seed)  // empty start
    for (const obj of levelData.objects) {
      const gy = ground.getHeightAtCoordinates(obj.wx, obj.wz) ?? 0
      if (obj.type === 'enemy_orc') {
        enemyMgr.spawnAt('weak_orc', new Vector3(obj.wx, gy, obj.wz))
      } else if (obj.type === 'enemy_goblin') {
        enemyMgr.spawnAt('goblin', new Vector3(obj.wx, gy, obj.wz))
      }
    }
    // Place goblins on tower tops from level data
    for (const pos of structures.getTowerTopPositions()) {
      enemyMgr.spawnAt('goblin', pos, true)
    }
  } else {
    // Procedural: spawn around camp centers
    const campCenters = structures.camps.map(c => c.center)
    enemyMgr = new EnemyManager(scene, ground, 20, seed, campCenters)
    // Place goblins on tower tops
    for (const pos of structures.getTowerTopPositions()) {
      enemyMgr.spawnAt('goblin', pos, true)
    }
  }

  // Set wall collision and projectile blocking for all enemies
  const wallCollider = (pos: Vector3) => structures.resolveCollision(pos)
  const projBlocker = (x: number, z: number) => structures.isInsideCabin(x, z)
  for (const e of enemyMgr.getEnemies()) {
    e.wallCollider = wallCollider
    e.projectileBlocker = projBlocker
  }

  // Move player to spawn point from level data
  if (levelData) {
    const spawn = levelData.objects.find(o => o.type === 'player_spawn')
    if (spawn) {
      const sy = (ground.getHeightAtCoordinates(spawn.wx, spawn.wz) ?? 0) + 2
      player.setPosition(spawn.wx, sy, spawn.wz)
    }
  }

  // Draw roads as brown strips on the ground
  if (levelData) {
    const roadMat = new StandardMaterial('roadMat', scene)
    roadMat.diffuseColor = new Color3(0.55, 0.42, 0.25)
    roadMat.specularColor = Color3.Black()
    for (let ri = 0; ri < levelData.roads.length; ri++) {
      const road = levelData.roads[ri]
      if (road.length < 2) continue
      // Build road segments as thin boxes lying on terrain
      for (let j = 0; j < road.length - 1; j++) {
        const [ax, az] = road[j]
        const [bx, bz] = road[j + 1]
        const ay = (ground.getHeightAtCoordinates(ax, az) ?? 0) + 0.05
        const by = (ground.getHeightAtCoordinates(bx, bz) ?? 0) + 0.05
        const mx = (ax + bx) / 2, mz = (az + bz) / 2, my = (ay + by) / 2
        const len = Math.sqrt((bx - ax) ** 2 + (bz - az) ** 2)
        if (len < 0.01) continue
        const seg = MeshBuilder.CreateBox(`road_${ri}_${j}`, {
          width: len, height: 0.08, depth: 2.5,
        }, scene)
        seg.position.set(mx, my, mz)
        seg.rotation.y = Math.atan2(bx - ax, bz - az)
        seg.material = roadMat
      }
    }
  }

  // Hearts HUD
  const heartsDiv = document.createElement('div')
  heartsDiv.id = 'hearts'
  heartsDiv.style.cssText = 'position:fixed;top:1rem;left:1rem;font-size:1.6rem;z-index:15;pointer-events:none;filter:drop-shadow(0 0 2px rgba(0,0,0,0.6));'
  document.body.appendChild(heartsDiv)

  function updateHearts() {
    const hp = player.getHealth()
    const max = player.getMaxHealth()
    let s = ''
    for (let i = 0; i < max; i++) {
      s += i < hp ? '\u2764\uFE0F' : '\uD83E\uDD0D'
    }
    heartsDiv.textContent = s
  }

  // Track per-enemy hits by attack animation (each new anim allows re-hit)
  const hitEnemyAnim = new Map<Enemy, string>()
  const hitByThrow = new Set<Enemy>()
  let wasAttacking = false
  let wasThrowing = false

  // Network send
  const SEND_INTERVAL = 1 / 20
  const ENEMY_SEND_INTERVAL = 1 / 10
  let sendTimer = 0
  let enemySendTimer = 0
  let lastEnemyVersion = 0

  // Render loop
  engine.runRenderLoop(() => {
    const dt = Math.min(engine!.getDeltaTime() / 1000, 0.05)

    player.update(dt)

    // Melee hit detection — per-animation tracking (each new attack anim resets)
    const attacking = player.isAttacking()
    const atkAnim = player.getAttackAnim()
    if (attacking && !wasAttacking) hitEnemyAnim.clear()
    wasAttacking = attacking

    if (attacking) {
      const progress = player.getAttackProgress()
      // Only register hits in the tail end of the swing (last 40%)
      if (progress >= 0.6) {
        const ppos = player.getPosition()
        for (const enemy of enemyMgr.getEnemies()) {
          if (enemy.isDead()) continue
          // Allow re-hit if this is a different attack animation than what last hit them
          if (hitEnemyAnim.get(enemy) === atkAnim) continue
          const edx = enemy.getPosition().x - ppos.x
          const edz = enemy.getPosition().z - ppos.z
          const dist = Math.sqrt(edx * edx + edz * edz)
          if (dist < 3.5) {
            enemy.takeDamage(1)
            hitEnemyAnim.set(enemy, atkAnim)
            // 3rd hit (sword_attack_c) knocks the enemy back hard
            if (atkAnim === 'sword_attack_c') {
              const dir = enemy.getPosition().subtract(ppos)
              dir.y = 0
              if (dir.length() > 0.01) dir.normalize()
              enemy.knockBack(dir, 80)
            }
          }
        }
      }
    }

    // Thrown sword hit detection
    const throwing = player.isThrowing()
    if (throwing && !wasThrowing) hitByThrow.clear()
    wasThrowing = throwing

    if (throwing) {
      const tp = player.getThrownSwordPos()
      if (tp) {
        for (const enemy of enemyMgr.getEnemies()) {
          if (enemy.isDead() || hitByThrow.has(enemy)) continue
          const dist = Vector3.Distance(tp, enemy.getPosition())
          if (dist < 3.0) {
            enemy.takeDamage(2)
            hitByThrow.add(enemy)
          }
        }
      }
    }

    // Dash attack hit detection (sword_dash hurts enemies on contact)
    if (player.isDashing()) {
      const ppos = player.getPosition()
      for (const enemy of enemyMgr.getEnemies()) {
        if (enemy.isDead()) continue
        if (hitEnemyAnim.get(enemy) === 'sword_dash') continue
        const edx = enemy.getPosition().x - ppos.x
        const edz = enemy.getPosition().z - ppos.z
        const dist = Math.sqrt(edx * edx + edz * edz)
        if (dist < 3.5) {
          enemy.takeDamage(2)
          hitEnemyAnim.set(enemy, 'sword_dash')
          const dir = enemy.getPosition().subtract(ppos)
          dir.y = 0
          if (dir.length() > 0.01) dir.normalize()
          enemy.knockBack(dir, 40)
        }
      }
    }

    // Rock projectile vs player (shield deflection)
    const isJoiner = network.isConnected() && !network.isHost
    const pp = player.getPosition()
    for (const enemy of enemyMgr.getEnemies()) {
      if (!enemy.isRanged()) continue
      const rocks = enemy.getProjectiles()
      for (let ri = rocks.length - 1; ri >= 0; ri--) {
        if (rocks[ri].bounced) continue  // can't hurt after first bounce
        const rp = rocks[ri].pos
        const dx2 = rp.x - pp.x
        const dz2 = rp.z - pp.z
        const dy2 = rp.y - (pp.y + 1.0)
        const dist = Math.sqrt(dx2 * dx2 + dy2 * dy2 + dz2 * dz2)
        if (dist < 1.5) {
          if (player.canBlockFrom(rp)) {
            enemy.deflectProjectile(ri)
          } else {
            player.takeDamage(1)
            // Bounce rock off player instead of removing
            enemy.bounceOffPlayer(ri, pp)
          }
        }
      }
      // Check if deflected rock hit the enemy itself (host only)
      if (!isJoiner && enemy.checkProjectileHitSelf()) {
        enemy.takeDamage(2)
      }
    }

    // Enemy AI + attacks on player (horizontal distance)
    // Host runs AI; joiner applies received states
    if (!isJoiner) {
      const positions = [player.getPosition()]
      if (network.isConnected() && network.lastRemoteState) {
        positions.push(new Vector3(
          network.lastRemoteState.x,
          network.lastRemoteState.y,
          network.lastRemoteState.z,
        ))
      }
      enemyMgr.update(dt, positions, (enemy) => {
        const pp = player.getPosition()
        // Use lunge direction for shield check (orc stops on contact now, but direction is reliable)
        const lungeDir = enemyMgr.getLungeDir(enemy)
        // The attack comes FROM the lunge direction — place virtual origin in front of player
        const attackOrigin = pp.add(lungeDir.scale(-5))
        if (player.canBlockFrom(attackOrigin)) {
          // Blocked — bounce player back while keeping defend pose
          const bounceDir = lungeDir.clone()
          bounceDir.y = 0
          if (bounceDir.length() > 0.01) bounceDir.normalize()
          player.shieldBounce(bounceDir, 60)
          return
        }
        // Knockback player away from enemy
        const ep = enemy.getPosition()
        const knockDir = pp.subtract(ep)
        knockDir.y = 0
        if (knockDir.length() > 0.01) knockDir.normalize()
        player.knockBack(knockDir, 150)
        player.takeDamage(enemy.damage)
      })
    } else if (network.lastEnemyStates && network.enemyStatesVersion !== lastEnemyVersion) {
      lastEnemyVersion = network.enemyStatesVersion
      enemyMgr.applyNetStates(network.lastEnemyStates)
    }

    updateHearts()

    // Send state to peer
    sendTimer += dt
    if (sendTimer >= SEND_INTERVAL && network.isConnected()) {
      sendTimer = 0
      network.sendPosition(player.getState())
    }

    // Host broadcasts enemy states
    if (network.isHost && network.isConnected()) {
      enemySendTimer += dt
      if (enemySendTimer >= ENEMY_SEND_INTERVAL) {
        enemySendTimer = 0
        network.sendEnemies(enemyMgr.getNetStates())
      }
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
