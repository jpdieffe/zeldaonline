import '@babylonjs/loaders/glTF'
import {
  Scene,
  Vector3,
  SceneLoader,
  TransformNode,
  AnimationGroup,
  AbstractMesh,
  GroundMesh,
  Color3,
  MeshBuilder,
  StandardMaterial,
} from '@babylonjs/core'
import type { EnemyNetState } from './types'

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
  singleGlb?: string                        // if set, one GLB with all anims baked in
  animNames?: Record<EnemyAnim, string>      // anim key → animation group name inside glb
  anims?: Record<EnemyAnim, string>          // anim key → glb filename (multi-GLB)
  scale: [number, number]
  speed: [number, number]
  health: [number, number]
  damage: number
  attackRange: number
  attackCooldown: number
  hitRadius: number
  isRanged?: boolean                         // throws projectiles instead of melee
  projectileSpeed?: number
}

const ENEMY_TYPES: EnemyTypeDef[] = [
  {
    folder: 'weak_orc',
    singleGlb: 'weak_orc.glb',
    animNames: { idle: 'Zombie_Idle_Loop', walk: 'Zombie_Walk_Fwd_Loop', bite: 'Sword_Attack', death: 'Death01' },
    scale: [1.6, 2.4], speed: [2, 3.5], health: [3, 5], damage: 1,
    attackRange: 2.5, attackCooldown: 1.5, hitRadius: 1.5,
  },
  {
    folder: 'goblin',
    singleGlb: 'goblin.glb',
    animNames: { idle: 'Zombie_Idle_Loop', walk: 'Zombie_Walk_Fwd_Loop', bite: 'Zombie_Scratch', death: 'Death01' },
    scale: [1.6, 2.4], speed: [2.5, 4], health: [2, 3], damage: 1,
    attackRange: 15, attackCooldown: 2.5, hitRadius: 0.8,
    isRanged: true, projectileSpeed: 18,
  },
]

const AGGRO_RANGE = 25
const DEAGGRO_RANGE = 35
const RESPAWN_TIME = 10

// Seeded PRNG (mulberry32)
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

function hashSeed(str: string): number {
  let h = 0
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0
  }
  return h
}

function rand(lo: number, hi: number, rng = Math.random): number { return lo + rng() * (hi - lo) }
function randInt(lo: number, hi: number, rng = Math.random): number { return Math.floor(rand(lo, hi + 1, rng)) }

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

  // Knockback
  private knockVel = Vector3.Zero()

  // AI State
  private state: 'idle' | 'chase' | 'attack' | 'dead' = 'idle'
  private wanderTimer = 0
  private wanderDir = Vector3.Zero()

  // Damage flash
  private flashTimer = 0
  private originalColors = new Map<AbstractMesh, Color3>()

  // Death disappear
  private deathAnimDuration = 1.5
  private deathAnimPlayed = false

  // Ranged projectile
  private projectiles: { mesh: AbstractMesh, pos: Vector3, vel: Vector3, life: number, bounced: boolean }[] = []
  private netRockMeshes: AbstractMesh[] = []

  // Lunge attack (melee)
  private lunging = false
  private lungeVel = Vector3.Zero()
  private lungeTimer = 0

  constructor(scene: Scene, ground: GroundMesh, typeDef: EnemyTypeDef, spawnPos: Vector3, rng: () => number = Math.random) {
    this.scene = scene
    this.ground = ground
    this.typeDef = typeDef
    this.spawnPos = spawnPos.clone()
    this.position = spawnPos.clone()

    this.scale = rand(typeDef.scale[0], typeDef.scale[1], rng)
    this.speed = rand(typeDef.speed[0], typeDef.speed[1], rng)
    this.maxHealth = randInt(typeDef.health[0], typeDef.health[1], rng)
    this.health = this.maxHealth
    this.hitRadius = typeDef.hitRadius * this.scale
    this.damage = typeDef.damage

    this.load()
  }

  private async load() {
    const folder = `./assets/bad_guys/${this.typeDef.folder}/`

    if (this.typeDef.singleGlb && this.typeDef.animNames) {
      // Single-GLB mode: one file with all animations baked in
      await this.loadSingleGlb(folder)
    } else if (this.typeDef.anims) {
      // Multi-GLB mode: separate files per animation
      await this.loadMultiGlb(folder)
    }

    if (Object.keys(this.entries).length > 0) {
      this.loaded = true
      this.showAnim('idle')
    }
  }

  private async loadSingleGlb(folder: string) {
    try {
      const result = await SceneLoader.ImportMeshAsync('', folder, this.typeDef.singleGlb!, this.scene)
      const pivot = new TransformNode(`enemy_pivot_single`, this.scene)
      pivot.position.copyFrom(this.position)
      const root = result.meshes[0] as unknown as TransformNode
      root.parent = pivot
      root.scaling.setAll(this.scale)

      const meshes = result.meshes.filter(m => m !== result.meshes[0])
      meshes.forEach(m => { m.isVisible = false })

      // Map animation groups by our EnemyAnim keys
      for (const [animKey, animName] of Object.entries(this.typeDef.animNames!) as [EnemyAnim, string][]) {
        const group = result.animationGroups.find(g => g.name === animName) ?? null
        if (group) group.stop()
        // All anims share the same pivot/root/meshes
        this.entries[animKey] = { pivot, root, meshes, group }
      }
    } catch (e) {
      console.warn(`Failed to load ${folder}${this.typeDef.singleGlb}:`, e)
    }
  }

  private async loadMultiGlb(folder: string) {
    const fileToAnim = new Map<string, EnemyAnim>()
    const animAliases = new Map<EnemyAnim, EnemyAnim>()

    for (const [animKey, fileName] of Object.entries(this.typeDef.anims!) as [EnemyAnim, string][]) {
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
  }

  /** Show one animation's meshes, hide all others, play its animation */
  private showAnim(anim: EnemyAnim) {
    if (!this.loaded) return

    // Stop previous animation
    const prevEntry = this.entries[this.currentAnim]
    if (prevEntry?.group) prevEntry.group.stop()

    if (this.typeDef.singleGlb) {
      // Single-GLB mode: all anims share same meshes, just switch animation group
      const entry = this.entries[anim]
      if (entry) {
        entry.meshes.forEach(m => { m.isVisible = true })
        if (entry.group) {
          entry.group.start(anim !== 'death', 1.0, entry.group.from, entry.group.to, false)
        }
      }
    } else {
      // Multi-GLB mode: hide all meshes, show target
      for (const entry of Object.values(this.entries)) {
        if (!entry) continue
        entry.meshes.forEach(m => { m.isVisible = false })
      }
      const entry = this.entries[anim]
      if (entry) {
        entry.meshes.forEach(m => { m.isVisible = true })
        if (entry.group) {
          entry.group.start(anim !== 'death', 1.0, entry.group.from, entry.group.to, false)
        }
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

  update(dt: number, playerPositions: Vector3[]): { wantAttack: boolean } {
    if (!this.loaded) return { wantAttack: false }

    // Update projectiles always (even while dead)
    this.updateProjectiles(dt)

    if (this.dead) {
      this.deathTimer -= dt
      if (this.flashTimer > 0) {
        this.flashTimer -= dt
        if (this.flashTimer <= 0) this.restoreColors()
      }
      // Hide meshes after death animation plays once
      if (!this.deathAnimPlayed) {
        this.deathAnimDuration -= dt
        if (this.deathAnimDuration <= 0) {
          this.deathAnimPlayed = true
          for (const entry of Object.values(this.entries)) {
            if (!entry) continue
            entry.meshes.forEach(m => { m.isVisible = false })
          }
        }
      }
      if (this.deathTimer <= 0) {
        this.respawn()
      }
      return { wantAttack: false }
    }

    this.attackCooldown -= dt

    // Find nearest player
    let nearestPos = playerPositions[0]
    let nearestDistSq = Infinity
    for (const pp of playerPositions) {
      const dx = pp.x - this.position.x
      const dz = pp.z - this.position.z
      const dsq = dx * dx + dz * dz
      if (dsq < nearestDistSq) { nearestDistSq = dsq; nearestPos = pp }
    }

    const toPlayer = nearestPos.subtract(this.position)
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
        if (this.attackCooldown <= 0) {
          this.attackCooldown = this.typeDef.attackCooldown
          if (this.typeDef.isRanged) {
            this.playAnim('bite')
            const dir = toPlayer.normalize()
            this.spawnRock(dir)
          } else {
            // Melee: lunge toward player
            this.lunging = true
            this.lungeTimer = 0.4
            const dir = toPlayer.length() > 0.01 ? toPlayer.normalize() : Vector3.Forward()
            this.lungeVel = dir.scale(this.speed * 4)
            this.lungeVel.y = 8  // jump arc
            this.playAnim('bite')
            wantAttack = true
          }
        } else {
          this.playAnim(this.lunging ? 'bite' : 'idle')
        }
      }
    }

    // Lunge movement
    if (this.lunging) {
      this.lungeTimer -= dt
      this.lungeVel.y -= 20 * dt  // gravity
      this.position.addInPlace(this.lungeVel.scale(dt))
      if (this.lungeTimer <= 0) {
        this.lunging = false
        this.lungeVel.set(0, 0, 0)
      }
    }

    // Apply knockback velocity
    if (this.knockVel.length() > 0.05) {
      this.position.addInPlace(this.knockVel.scale(dt))
      // Friction
      this.knockVel.scaleInPlace(1 - 5 * dt)
    } else {
      this.knockVel.set(0, 0, 0)
    }

    // Stay on ground
    this.position.y = this.getGroundY(this.position.x, this.position.z)

    // Facing direction (+ PI to face forward)
    if (this.state === 'chase' || this.state === 'attack') {
      this.facingY = Math.atan2(toPlayer.x, toPlayer.z) + Math.PI
    } else if (this.wanderDir.length() > 0.01) {
      this.facingY = Math.atan2(this.wanderDir.x, this.wanderDir.z) + Math.PI
    }

    // Damage flash timer
    if (this.flashTimer > 0) {
      this.flashTimer -= dt
      if (this.flashTimer <= 0) {
        this.restoreColors()
      }
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
    this.flashRed()
    if (this.health <= 0) {
      this.health = 0
      this.dead = true
      this.state = 'dead'
      this.deathTimer = RESPAWN_TIME
      this.deathAnimDuration = 1.5
      this.deathAnimPlayed = false
      this.playAnim('death')
    }
  }

  knockBack(dir: Vector3, force: number) {
    this.knockVel = dir.scale(force)
  }

  private flashRed() {
    this.flashTimer = 0.2
    // Tint all meshes across all entries with emissive red glow
    for (const entry of Object.values(this.entries)) {
      if (!entry) continue
      for (const m of entry.meshes) {
        if (!m.material) continue
        const mat = m.material as any
        // Works on both StandardMaterial and PBRMaterial
        if (mat.emissiveColor !== undefined) {
          if (!this.originalColors.has(m)) {
            this.originalColors.set(m, mat.emissiveColor ? mat.emissiveColor.clone() : new Color3(0, 0, 0))
          }
          mat.emissiveColor = new Color3(1, 0.15, 0.15)
        }
      }
    }
  }

  private restoreColors() {
    for (const [m, color] of this.originalColors) {
      if (!m.material) continue
      const mat = m.material as any
      if (mat.emissiveColor !== undefined) mat.emissiveColor = color
    }
    this.originalColors.clear()
  }

  private respawn() {
    this.dead = false
    this.health = this.maxHealth
    this.position = this.spawnPos.clone()
    this.position.y = this.getGroundY(this.position.x, this.position.z)
    this.state = 'idle'
    this.wanderTimer = 0
    this.deathAnimPlayed = false
    this.deathAnimDuration = 1.5
    this.playAnim('idle')
  }

  // ── Rock projectile system ──────────────────────────────────────────────
  private spawnRock(dir: Vector3) {
    const rockMesh = MeshBuilder.CreateSphere('rock', { diameter: 0.3 }, this.scene)
    const mat = new StandardMaterial('rockMat', this.scene)
    mat.diffuseColor = new Color3(0.45, 0.35, 0.25)
    rockMesh.material = mat

    const spawnPos = this.position.clone()
    spawnPos.y += 1.5 * this.scale
    rockMesh.position.copyFrom(spawnPos)

    const speed = this.typeDef.projectileSpeed ?? 18
    const vel = dir.scale(speed)
    vel.y = 3 // slight arc

    this.projectiles.push({ mesh: rockMesh, pos: spawnPos.clone(), vel: vel.clone(), life: 5, bounced: false })
  }

  private updateProjectiles(dt: number) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i]
      p.vel.y -= 15 * dt // gravity
      p.pos.addInPlace(p.vel.scale(dt))
      p.mesh.position.copyFrom(p.pos)
      p.life -= dt

      // Hit ground — bounce or dispose
      const gy = this.getGroundY(p.pos.x, p.pos.z)
      if (p.pos.y <= gy) {
        if (!p.bounced) {
          // First bounce: reflect Y, dampen heavily
          p.bounced = true
          p.pos.y = gy
          p.vel.y = Math.abs(p.vel.y) * 0.3
          p.vel.x *= 0.4
          p.vel.z *= 0.4
        } else {
          // Already bounced and hit ground again — dispose
          p.mesh.dispose()
          this.projectiles.splice(i, 1)
          continue
        }
      }

      if (p.life <= 0) {
        p.mesh.dispose()
        this.projectiles.splice(i, 1)
      }
    }
  }

  /** Get active projectiles for hit detection in main.ts */
  getProjectiles(): { pos: Vector3, vel: Vector3, mesh: AbstractMesh, bounced: boolean }[] {
    return this.projectiles.map(p => ({ pos: p.pos.clone(), vel: p.vel, mesh: p.mesh, bounced: p.bounced }))
  }

  /** Deflect a projectile: reverse its velocity back toward this enemy */
  deflectProjectile(index: number) {
    const p = this.projectiles[index]
    if (!p) return
    // Reverse direction and boost
    const toEnemy = this.position.subtract(p.pos)
    toEnemy.y = 0
    if (toEnemy.length() > 0.01) toEnemy.normalize()
    const speed = (this.typeDef.projectileSpeed ?? 18) * 1.5
    p.vel = toEnemy.scale(speed)
    p.vel.y = 2
  }

  /** Check if any projectile hits this enemy (for deflected rocks) */
  checkProjectileHitSelf(): boolean {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i]
      // Only check rocks heading back toward the enemy (deflected)
      const toEnemy = this.position.subtract(p.pos)
      toEnemy.y = 0
      if (toEnemy.length() < this.hitRadius * 1.5) {
        // Check if rock is moving toward enemy (dot product > 0)
        const dot = Vector3.Dot(p.vel, toEnemy)
        if (dot > 0) {
          p.mesh.dispose()
          this.projectiles.splice(i, 1)
          return true
        }
      }
    }
    return false
  }

  /** Bounce a projectile off the player: deflect away from player pos */
  bounceOffPlayer(index: number, playerPos: Vector3) {
    const p = this.projectiles[index]
    if (!p) return
    const away = p.pos.subtract(playerPos)
    away.y = 0
    if (away.length() > 0.01) away.normalize()
    p.vel.x = away.x * 6
    p.vel.z = away.z * 6
    p.vel.y = 4
    p.bounced = true
  }

  isRanged(): boolean { return !!this.typeDef.isRanged }

  isDead(): boolean { return this.dead }
  getPosition(): Vector3 { return this.position.clone() }
  getHealth(): number { return this.health }
  getMaxHealth(): number { return this.maxHealth }

  getNetState(): EnemyNetState {
    return {
      x: this.position.x, z: this.position.z,
      ry: this.facingY, anim: this.currentAnim, hp: this.health,
      rocks: this.projectiles.map(p => ({
        x: p.pos.x, y: p.pos.y, z: p.pos.z,
        vx: p.vel.x, vy: p.vel.y, vz: p.vel.z,
        b: p.bounced,
      })),
    }
  }

  applyNetState(s: EnemyNetState) {
    if (!this.loaded) return
    this.position.x = s.x
    this.position.z = s.z
    this.position.y = this.getGroundY(s.x, s.z)
    this.facingY = s.ry
    // Sync health
    if (s.hp < this.health && !this.dead) {
      this.flashRed()
    }
    this.health = s.hp
    if (s.hp <= 0 && !this.dead) {
      this.dead = true
      this.state = 'dead'
      this.deathTimer = RESPAWN_TIME
      this.deathAnimDuration = 1.5
      this.deathAnimPlayed = false
    }
    if (s.hp > 0 && this.dead) {
      this.dead = false
      this.state = 'idle'
    }
    // Sync animation
    const anim = s.anim as EnemyAnim
    this.playAnim(anim)
    // Sync pivots
    for (const entry of Object.values(this.entries)) {
      if (!entry) continue
      entry.pivot.position.copyFrom(this.position)
      entry.pivot.rotation.y = this.facingY
    }

    // Sync projectiles from host
    const netRocks = s.rocks ?? []
    while (this.netRockMeshes.length < netRocks.length) {
      const mesh = MeshBuilder.CreateSphere('netRock', { diameter: 0.3 }, this.scene)
      const mat = new StandardMaterial('netRockMat', this.scene)
      mat.diffuseColor = new Color3(0.45, 0.35, 0.25)
      mesh.material = mat
      this.netRockMeshes.push(mesh)
    }
    while (this.netRockMeshes.length > netRocks.length) {
      this.netRockMeshes.pop()!.dispose()
    }
    this.projectiles.length = 0
    for (let i = 0; i < netRocks.length; i++) {
      const r = netRocks[i]
      this.netRockMeshes[i].position.set(r.x, r.y, r.z)
      this.projectiles.push({
        mesh: this.netRockMeshes[i],
        pos: new Vector3(r.x, r.y, r.z),
        vel: new Vector3(r.vx, r.vy, r.vz),
        life: 5,
        bounced: r.b ?? false,
      })
    }
  }

  removeProjectile(index: number) {
    if (index < 0 || index >= this.projectiles.length) return
    this.projectiles[index].mesh.dispose()
    this.projectiles.splice(index, 1)
    // Also remove from netRockMeshes if present
    if (index < this.netRockMeshes.length) {
      this.netRockMeshes.splice(index, 1)
    }
  }

  dispose() {
    const disposed = new Set<TransformNode>()
    for (const entry of Object.values(this.entries)) {
      if (!entry || disposed.has(entry.pivot)) continue
      disposed.add(entry.pivot)
      entry.group?.stop()
      entry.pivot.dispose()
    }
    for (const p of this.projectiles) p.mesh.dispose()
    this.projectiles.length = 0
    for (const m of this.netRockMeshes) m.dispose()
    this.netRockMeshes.length = 0
  }
}

// ── Enemy Manager ───────────────────────────────────────────────────────────
export class EnemyManager {
  private enemies: Enemy[] = []

  constructor(scene: Scene, ground: GroundMesh, count = 20, seed?: string) {
    const rng = seed ? mulberry32(hashSeed(seed)) : Math.random
    const GROUND_SIZE = 200
    const half = GROUND_SIZE / 2 - 10
    const CLUSTER_SIZE = 3
    const CLUSTER_SPREAD = 4  // units apart within a cluster

    const clusterCount = Math.ceil(count / CLUSTER_SIZE)
    let spawned = 0

    for (let c = 0; c < clusterCount && spawned < count; c++) {
      const typeDef = ENEMY_TYPES[Math.floor(rng() * ENEMY_TYPES.length)]
      // Pick cluster center
      const cx = rand(-half, half, rng)
      const cz = rand(-half, half, rng)
      const cy = ground.getHeightAtCoordinates(cx, cz) ?? 0
      if (cy < -0.2) continue  // skip water clusters

      for (let i = 0; i < CLUSTER_SIZE && spawned < count; i++) {
        const ox = (i === 0) ? 0 : rand(-CLUSTER_SPREAD, CLUSTER_SPREAD, rng)
        const oz = (i === 0) ? 0 : rand(-CLUSTER_SPREAD, CLUSTER_SPREAD, rng)
        const x = cx + ox
        const z = cz + oz
        const y = ground.getHeightAtCoordinates(x, z) ?? 0
        if (y < -0.2) continue
        const enemy = new Enemy(scene, ground, typeDef, new Vector3(x, y, z), rng)
        this.enemies.push(enemy)
        spawned++
      }
    }
  }

  update(dt: number, playerPositions: Vector3[], onEnemyAttack: (enemy: Enemy) => void) {
    for (const enemy of this.enemies) {
      const result = enemy.update(dt, playerPositions)
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

  getNetStates(): EnemyNetState[] {
    return this.enemies.map(e => e.getNetState())
  }

  applyNetStates(states: EnemyNetState[]) {
    for (let i = 0; i < states.length && i < this.enemies.length; i++) {
      this.enemies[i].applyNetState(states[i])
    }
  }
}
