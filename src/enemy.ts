import '@babylonjs/loaders/glTF'
import {
  Scene,
  Vector3,
  SceneLoader,
  TransformNode,
  AnimationGroup,
  AbstractMesh,
  GroundMesh,
} from '@babylonjs/core'

// ── Enemy type definitions ──────────────────────────────────────────────────
type EnemyAnim = 'idle' | 'walk' | 'bite' | 'death'

interface AnimEntry {
  pivot: TransformNode
  root: TransformNode
  meshes: AbstractMesh[]
  group: AnimationGroup | null
}

interface EnemyTypeDef {
  folder: string
  anims: Record<EnemyAnim, string>   // anim key → glb filename
  scale: [number, number]
  speed: [number, number]
  health: [number, number]
  damage: number
  attackRange: number
  attackCooldown: number
  hitRadius: number
}

const ENEMY_TYPES: EnemyTypeDef[] = [
  {
    folder: 'spider',
    anims: { idle: 'idle.glb', walk: 'walk.glb', bite: 'idle.glb', death: 'death.glb' },
    scale: [0.8, 1.5], speed: [2, 4], health: [2, 4], damage: 1,
    attackRange: 2.5, attackCooldown: 1.5, hitRadius: 1.5,
  },
  {
    folder: 'pillbug',
    anims: { idle: 'idle.glb', walk: 'walk.glb', bite: 'bite.glb', death: 'death.glb' },
    scale: [0.6, 1.2], speed: [1.5, 3], health: [3, 5], damage: 1,
    attackRange: 2.0, attackCooldown: 2.0, hitRadius: 1.2,
  },
  {
    folder: 'ladybug',
    anims: { idle: 'idle.glb', walk: 'walk.glb', bite: 'bite.glb', death: 'death.glb' },
    scale: [0.7, 1.3], speed: [2, 3.5], health: [2, 3], damage: 1,
    attackRange: 2.0, attackCooldown: 1.8, hitRadius: 1.2,
  },
  {
    folder: 'fox',
    anims: { idle: 'idle.glb', walk: 'run.glb', bite: 'bite.glb', death: 'death.glb' },
    scale: [0.8, 1.4], speed: [3, 5], health: [3, 5], damage: 1,
    attackRange: 3.5, attackCooldown: 1.2, hitRadius: 2.0,
  },
  {
    folder: 'mantis',
    anims: { idle: 'idle.glb', walk: 'walk.glb', bite: 'bite.glb', death: 'death.glb' },
    scale: [1.0, 2.0], speed: [2, 3.5], health: [4, 7], damage: 2,
    attackRange: 3.0, attackCooldown: 1.5, hitRadius: 2.0,
  },
]

const AGGRO_RANGE = 25
const DEAGGRO_RANGE = 35
const RESPAWN_TIME = 10

function rand(lo: number, hi: number): number { return lo + Math.random() * (hi - lo) }
function randInt(lo: number, hi: number): number { return Math.floor(rand(lo, hi + 1)) }

// ── Single Enemy ────────────────────────────────────────────────────────────
export class Enemy {
  private scene: Scene
  private ground: GroundMesh
  private typeDef: EnemyTypeDef

  // Each animation has its own root + meshes + animation group (from its own GLB)
  private entries: Partial<Record<EnemyAnim, AnimEntry>> = {}
  private currentAnim: EnemyAnim = 'idle'
  private loaded = false
  private facingY = 0

  position: Vector3
  private spawnPos: Vector3
  private health: number
  private maxHealth: number
  private speed: number
  private scale: number
  private dead = false
  private deathTimer = 0
  private attackCooldown = 0
  hitRadius: number
  damage: number

  // AI State
  private state: 'idle' | 'chase' | 'attack' | 'dead' = 'idle'
  private wanderTimer = 0
  private wanderDir = Vector3.Zero()

  constructor(scene: Scene, ground: GroundMesh, typeDef: EnemyTypeDef, spawnPos: Vector3) {
    this.scene = scene
    this.ground = ground
    this.typeDef = typeDef
    this.spawnPos = spawnPos.clone()
    this.position = spawnPos.clone()

    this.scale = rand(typeDef.scale[0], typeDef.scale[1])
    this.speed = rand(typeDef.speed[0], typeDef.speed[1])
    this.maxHealth = randInt(typeDef.health[0], typeDef.health[1])
    this.health = this.maxHealth
    this.hitRadius = typeDef.hitRadius * this.scale
    this.damage = typeDef.damage

    this.load()
  }

  private async load() {
    const folder = `./assets/bad_guys/${this.typeDef.folder}/`

    // Deduplicate: if two anims point to same file, share the entry
    const fileToAnim = new Map<string, EnemyAnim>()
    const animAliases = new Map<EnemyAnim, EnemyAnim>()

    for (const [animKey, fileName] of Object.entries(this.typeDef.anims) as [EnemyAnim, string][]) {
      if (fileToAnim.has(fileName)) {
        // This anim uses the same file as another — alias it
        animAliases.set(animKey, fileToAnim.get(fileName)!)
      } else {
        fileToAnim.set(fileName, animKey)
      }
    }

    // Load each unique GLB
    for (const [fileName, animKey] of fileToAnim) {
      try {
        const result = await SceneLoader.ImportMeshAsync('', folder, fileName, this.scene)
        const pivot = new TransformNode(`enemy_pivot_${animKey}`, this.scene)
        pivot.position.copyFrom(this.position)
        const root = result.meshes[0] as unknown as TransformNode
        root.parent = pivot
        root.scaling.setAll(this.scale)

        const meshes = result.meshes.filter(m => m !== result.meshes[0])
        // Hide all initially
        meshes.forEach(m => { m.isVisible = false })

        const group = result.animationGroups.length > 0 ? result.animationGroups[0] : null
        if (group) group.stop()

        this.entries[animKey] = { pivot, root, meshes, group }
      } catch (e) {
        console.warn(`Failed to load ${folder}${fileName}:`, e)
      }
    }

    // Set up aliases
    for (const [alias, target] of animAliases) {
      if (this.entries[target]) {
        this.entries[alias] = this.entries[target]
      }
    }

    if (Object.keys(this.entries).length > 0) {
      this.loaded = true
      this.showAnim('idle')
    }
  }

  /** Show one animation's meshes, hide all others, play its animation */
  private showAnim(anim: EnemyAnim) {
    if (!this.loaded) return

    // Stop previous animation
    const prevEntry = this.entries[this.currentAnim]
    if (prevEntry?.group) prevEntry.group.stop()

    // Hide all meshes
    for (const entry of Object.values(this.entries)) {
      if (!entry) continue
      entry.meshes.forEach(m => { m.isVisible = false })
    }

    // Show + play the target animation
    const entry = this.entries[anim]
    if (entry) {
      entry.meshes.forEach(m => { m.isVisible = true })
      if (entry.group) {
        entry.group.start(anim !== 'death', 1.0, entry.group.from, entry.group.to, false)
      }
    }

    this.currentAnim = anim
  }

  private playAnim(anim: EnemyAnim) {
    if (anim === this.currentAnim || !this.loaded) return
    this.showAnim(anim)
  }

  private getGroundY(x: number, z: number): number {
    const y = this.ground.getHeightAtCoordinates(x, z)
    return (y != null && isFinite(y)) ? y : 0
  }

  update(dt: number, playerPos: Vector3): { wantAttack: boolean } {
    if (!this.loaded) return { wantAttack: false }

    if (this.dead) {
      this.deathTimer -= dt
      if (this.deathTimer <= 0) {
        this.respawn()
      }
      return { wantAttack: false }
    }

    this.attackCooldown -= dt

    const toPlayer = playerPos.subtract(this.position)
    toPlayer.y = 0
    const dist = toPlayer.length()
    let wantAttack = false

    // State transitions
    if (this.state === 'idle') {
      if (dist < AGGRO_RANGE) {
        this.state = 'chase'
      } else {
        // Wander
        this.wanderTimer -= dt
        if (this.wanderTimer <= 0) {
          this.wanderTimer = rand(2, 5)
          const angle = Math.random() * Math.PI * 2
          this.wanderDir = new Vector3(Math.sin(angle), 0, Math.cos(angle))
        }
        this.position.addInPlace(this.wanderDir.scale(this.speed * 0.3 * dt))
        this.playAnim('walk')
      }
    }

    if (this.state === 'chase') {
      if (dist > DEAGGRO_RANGE) {
        this.state = 'idle'
      } else if (dist < this.typeDef.attackRange * this.scale) {
        this.state = 'attack'
      } else {
        const dir = toPlayer.normalize()
        this.position.addInPlace(dir.scale(this.speed * dt))
        this.playAnim('walk')
      }
    }

    if (this.state === 'attack') {
      if (dist > this.typeDef.attackRange * this.scale * 1.5) {
        this.state = 'chase'
      } else {
        this.playAnim('bite')
        if (this.attackCooldown <= 0) {
          wantAttack = true
          this.attackCooldown = this.typeDef.attackCooldown
        }
      }
    }

    // Stay on ground
    this.position.y = this.getGroundY(this.position.x, this.position.z)

    // Facing direction
    if (this.state === 'chase' || this.state === 'attack') {
      this.facingY = Math.atan2(toPlayer.x, toPlayer.z)
    } else if (this.wanderDir.length() > 0.01) {
      this.facingY = Math.atan2(this.wanderDir.x, this.wanderDir.z)
    }

    // Sync ALL pivots to current position + rotation
    for (const entry of Object.values(this.entries)) {
      if (!entry) continue
      entry.pivot.position.copyFrom(this.position)
      entry.pivot.rotation.y = this.facingY
    }

    return { wantAttack }
  }

  takeDamage(amount: number) {
    if (this.dead) return
    this.health -= amount
    if (this.health <= 0) {
      this.health = 0
      this.dead = true
      this.state = 'dead'
      this.deathTimer = RESPAWN_TIME
      this.playAnim('death')
    }
  }

  private respawn() {
    this.dead = false
    this.health = this.maxHealth
    this.position = this.spawnPos.clone()
    this.position.y = this.getGroundY(this.position.x, this.position.z)
    this.state = 'idle'
    this.wanderTimer = 0
    this.playAnim('idle')
  }

  isDead(): boolean { return this.dead }
  getPosition(): Vector3 { return this.position.clone() }
  getHealth(): number { return this.health }
  getMaxHealth(): number { return this.maxHealth }

  dispose() {
    const disposed = new Set<TransformNode>()
    for (const entry of Object.values(this.entries)) {
      if (!entry || disposed.has(entry.pivot)) continue
      disposed.add(entry.pivot)
      entry.group?.stop()
      entry.pivot.dispose()
    }
  }
}

// ── Enemy Manager ───────────────────────────────────────────────────────────
export class EnemyManager {
  private enemies: Enemy[] = []

  constructor(scene: Scene, ground: GroundMesh, count = 20) {
    const GROUND_SIZE = 200
    const half = GROUND_SIZE / 2 - 10

    for (let i = 0; i < count; i++) {
      const typeDef = ENEMY_TYPES[Math.floor(Math.random() * ENEMY_TYPES.length)]
      const x = rand(-half, half)
      const z = rand(-half, half)
      const y = ground.getHeightAtCoordinates(x, z) ?? 0
      // Skip spawning in water
      if (y < -0.2) { count++; continue }
      const enemy = new Enemy(scene, ground, typeDef, new Vector3(x, y, z))
      this.enemies.push(enemy)
    }
  }

  update(dt: number, playerPos: Vector3, onEnemyAttack: (enemy: Enemy) => void) {
    for (const enemy of this.enemies) {
      const result = enemy.update(dt, playerPos)
      if (result.wantAttack) {
        onEnemyAttack(enemy)
      }
    }
  }

  /** Check if player's sword hits any enemy */
  checkSwordHits(swordPos: Vector3, damage: number) {
    for (const enemy of this.enemies) {
      if (enemy.isDead()) continue
      const dist = Vector3.Distance(swordPos, enemy.getPosition())
      if (dist < enemy.hitRadius) {
        enemy.takeDamage(damage)
      }
    }
  }

  getEnemies(): Enemy[] { return this.enemies }
}
