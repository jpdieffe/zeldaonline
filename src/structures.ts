import {
  Scene,
  Vector3,
  MeshBuilder,
  StandardMaterial,
  Color3,
  Mesh,
  GroundMesh,
  ParticleSystem,
  Color4,
} from '@babylonjs/core'

// ── Seeded RNG helpers (same as enemy.ts) ──────────────────────────────────
function hashSeed(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h >>> 0
}
function mulberry32(seed: number): () => number {
  let s = seed | 0
  return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
function rand(lo: number, hi: number, rng: () => number): number { return lo + rng() * (hi - lo) }

export interface CampDef {
  center: Vector3
  cabins: Vector3[]
  campfire: Vector3
  hasTower: boolean
  towerPos: Vector3
}

export interface CabinBounds {
  cx: number; cz: number
  halfW: number; halfD: number
  sinR: number; cosR: number
}

/** All structure meshes that the player can stand on */
export class Structures {
  readonly collidable: Mesh[] = []
  readonly camps: CampDef[] = []
  readonly cabinBounds: CabinBounds[] = []
  private particles: ParticleSystem[] = []

  constructor(
    private scene: Scene,
    private ground: GroundMesh,
    campCount: number,
    seed?: string,
  ) {
    const rng = seed ? mulberry32(hashSeed(seed)) : Math.random
    const half = 80 // stay within -80..80 (ground is 200 wide)

    for (let i = 0; i < campCount; i++) {
      // Pick camp center on dry land
      let cx: number, cz: number, cy: number
      let tries = 0
      do {
        cx = rand(-half, half, rng)
        cz = rand(-half, half, rng)
        cy = ground.getHeightAtCoordinates(cx, cz) ?? 0
        tries++
      } while (cy < 0 && tries < 20)
      if (cy < 0) continue

      const camp: CampDef = {
        center: new Vector3(cx, cy, cz),
        cabins: [],
        campfire: new Vector3(cx, cy, cz),
        hasTower: rng() < 0.4, // 40% chance of tower
        towerPos: Vector3.Zero(),
      }

      // Campfire at center
      this.buildCampfire(cx, cy, cz, i)
      camp.campfire.set(cx, cy, cz)

      // 2-3 cabins scattered around center  
      const cabinCount = 2 + (rng() < 0.4 ? 1 : 0)
      for (let j = 0; j < cabinCount; j++) {
        const angle = (j / cabinCount) * Math.PI * 2 + rand(-0.3, 0.3, rng)
        const dist = rand(8, 14, rng)
        const bx = cx + Math.cos(angle) * dist
        const bz = cz + Math.sin(angle) * dist
        const by = ground.getHeightAtCoordinates(bx, bz) ?? 0
        if (by < -0.2) continue
        const rotY = Math.atan2(cx - bx, cz - bz) // face toward camp center
        this.buildCabin(bx, by, bz, rotY, i * 10 + j, rng)
        camp.cabins.push(new Vector3(bx, by, bz))
      }

      // Tower (if any) — opposite side from first cabin
      if (camp.hasTower) {
        const tAngle = rand(0, Math.PI * 2, rng)
        const tDist = rand(10, 16, rng)
        const tx = cx + Math.cos(tAngle) * tDist
        const tz = cz + Math.sin(tAngle) * tDist
        const ty = ground.getHeightAtCoordinates(tx, tz) ?? 0
        if (ty >= -0.2) {
          this.buildTower(tx, ty, tz, i, rng)
          camp.towerPos.set(tx, ty, tz)
        } else {
          camp.hasTower = false
        }
      }

      this.camps.push(camp)
    }
  }

  // ── Log Cabin ──────────────────────────────────────────────────────────────
  private buildCabin(x: number, y: number, z: number, rotY: number, id: number, rng: () => number) {
    const woodMat = new StandardMaterial(`cabinWood_${id}`, this.scene)
    woodMat.diffuseColor = new Color3(0.45, 0.28, 0.12)
    woodMat.specularColor = Color3.Black()

    const roofMat = new StandardMaterial(`cabinRoof_${id}`, this.scene)
    roofMat.diffuseColor = new Color3(0.3, 0.15, 0.07)
    roofMat.specularColor = Color3.Black()

    const w = rand(3.5, 5, rng) // width
    const d = rand(3, 4.5, rng)  // depth
    const h = rand(2.5, 3.5, rng)  // wall height

    // Walls — 4 thin boxes
    const wallThick = 0.3
    const walls = [
      // front
      MeshBuilder.CreateBox(`cabin_fw_${id}`, { width: w, height: h, depth: wallThick }, this.scene),
      // back
      MeshBuilder.CreateBox(`cabin_bw_${id}`, { width: w, height: h, depth: wallThick }, this.scene),
      // left
      MeshBuilder.CreateBox(`cabin_lw_${id}`, { width: wallThick, height: h, depth: d }, this.scene),
      // right
      MeshBuilder.CreateBox(`cabin_rw_${id}`, { width: wallThick, height: h, depth: d }, this.scene),
    ]
    walls[0].position.set(0, h / 2, d / 2)
    walls[1].position.set(0, h / 2, -d / 2)
    walls[2].position.set(-w / 2, h / 2, 0)
    walls[3].position.set(w / 2, h / 2, 0)
    for (const wall of walls) wall.material = woodMat

    // Floor
    const floor = MeshBuilder.CreateBox(`cabin_floor_${id}`, { width: w, height: 0.15, depth: d }, this.scene)
    floor.position.set(0, 0.075, 0)
    floor.material = woodMat

    // Roof — two angled planes meeting at a ridge
    const roofOverhang = 0.5
    const roofH = 1.8
    const roofW = Math.sqrt((w / 2 + roofOverhang) ** 2 + roofH ** 2)
    const roofAngle = Math.atan2(roofH, w / 2 + roofOverhang)
    const roofL = MeshBuilder.CreateBox(`cabin_rl_${id}`, { width: roofW, height: 0.12, depth: d + roofOverhang * 2 }, this.scene)
    roofL.rotation.z = roofAngle
    roofL.position.set(-w / 4 - roofOverhang / 4, h + roofH / 2, 0)
    roofL.material = roofMat

    const roofR = MeshBuilder.CreateBox(`cabin_rr_${id}`, { width: roofW, height: 0.12, depth: d + roofOverhang * 2 }, this.scene)
    roofR.rotation.z = -roofAngle
    roofR.position.set(w / 4 + roofOverhang / 4, h + roofH / 2, 0)
    roofR.material = roofMat

    // Merge into single positioned mesh
    const parts = [...walls, floor, roofL, roofR]
    const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, true)
    if (merged) {
      merged.name = `cabin_${id}`
      merged.position.set(x, y, z)
      merged.rotation.y = rotY
      merged.material = woodMat  // fallback; merge keeps sub-materials
      // Re-apply materials via multi-material if needed
      merged.checkCollisions = false
      this.collidable.push(merged)
      // Store oriented bounding box for XZ collision
      this.cabinBounds.push({
        cx: x, cz: z,
        halfW: w / 2 + 0.5, halfD: d / 2 + 0.5, // pad by character radius
        sinR: Math.sin(-rotY), cosR: Math.cos(-rotY),
      })
    }
  }

  // ── Campfire ──────────────────────────────────────────────────────────────
  private buildCampfire(x: number, y: number, z: number, id: number) {
    // Stone ring
    const ring = MeshBuilder.CreateTorus(`fire_ring_${id}`, {
      diameter: 1.8, thickness: 0.35, tessellation: 12,
    }, this.scene)
    ring.position.set(x, y + 0.15, z)
    const stoneMat = new StandardMaterial(`fireStoneMat_${id}`, this.scene)
    stoneMat.diffuseColor = new Color3(0.4, 0.4, 0.38)
    stoneMat.specularColor = Color3.Black()
    ring.material = stoneMat

    // Log pile
    for (let i = 0; i < 3; i++) {
      const log = MeshBuilder.CreateCylinder(`fire_log_${id}_${i}`, {
        height: 1.2, diameter: 0.2, tessellation: 6,
      }, this.scene)
      const angle = (i / 3) * Math.PI * 2
      log.position.set(x + Math.cos(angle) * 0.3, y + 0.2, z + Math.sin(angle) * 0.3)
      log.rotation.z = Math.PI / 2 + (i * 0.3)
      log.rotation.y = angle
      const logMat = new StandardMaterial(`fireLogMat_${id}_${i}`, this.scene)
      logMat.diffuseColor = new Color3(0.35, 0.2, 0.08)
      logMat.specularColor = Color3.Black()
      log.material = logMat
    }

    // Fire particles
    const ps = new ParticleSystem(`fire_${id}`, 80, this.scene)
    ps.createPointEmitter(new Vector3(-0.2, 0, -0.2), new Vector3(0.2, 1, 0.2))
    ps.emitter = new Vector3(x, y + 0.3, z)
    ps.minLifeTime = 0.3
    ps.maxLifeTime = 0.8
    ps.minSize = 0.15
    ps.maxSize = 0.5
    ps.emitRate = 40
    ps.color1 = new Color4(1, 0.6, 0.1, 1)
    ps.color2 = new Color4(1, 0.2, 0, 1)
    ps.colorDead = new Color4(0.2, 0.2, 0.2, 0)
    ps.minEmitPower = 0.5
    ps.maxEmitPower = 1.5
    ps.updateSpeed = 0.02
    ps.blendMode = ParticleSystem.BLENDMODE_ADD
    ps.start()
    this.particles.push(ps)
  }

  // ── Watch Tower ───────────────────────────────────────────────────────────
  buildTower(x: number, y: number, z: number, id: number, rng: () => number) {
    const woodMat = new StandardMaterial(`towerWood_${id}`, this.scene)
    woodMat.diffuseColor = new Color3(0.5, 0.32, 0.15)
    woodMat.specularColor = Color3.Black()

    const platformMat = new StandardMaterial(`towerPlat_${id}`, this.scene)
    platformMat.diffuseColor = new Color3(0.4, 0.25, 0.1)
    platformMat.specularColor = Color3.Black()

    // 4 vertical posts
    const postH = 12
    const postW = 0.35
    const baseW = 3 // distance between posts
    const posts: Mesh[] = []
    const corners = [
      [-baseW / 2, -baseW / 2],
      [baseW / 2, -baseW / 2],
      [baseW / 2, baseW / 2],
      [-baseW / 2, baseW / 2],
    ]
    for (let i = 0; i < 4; i++) {
      const post = MeshBuilder.CreateBox(`tower_post_${id}_${i}`, {
        width: postW, height: postH, depth: postW,
      }, this.scene)
      post.position.set(x + corners[i][0], y + postH / 2, z + corners[i][1])
      post.material = woodMat
      posts.push(post)
    }

    // Platforms at 3 heights — player can jump between them
    const platformHeights = [3, 6.5, 10]
    const platformSize = [3.5, 3.5, 4] // top platform slightly wider
    const platforms: Mesh[] = []
    for (let p = 0; p < platformHeights.length; p++) {
      const ph = platformHeights[p]
      const ps = platformSize[p]
      const plat = MeshBuilder.CreateBox(`tower_plat_${id}_${p}`, {
        width: ps, height: 0.3, depth: ps,
      }, this.scene)
      plat.position.set(x, y + ph, z)
      plat.material = platformMat
      this.collidable.push(plat) // player can stand on these
      platforms.push(plat)

      // Railing on top platform
      if (p === platformHeights.length - 1) {
        const railH = 1.0
        const railThick = 0.15
        const railings = [
          MeshBuilder.CreateBox(`tower_rail_${id}_f`, { width: ps, height: railH, depth: railThick }, this.scene),
          MeshBuilder.CreateBox(`tower_rail_${id}_b`, { width: ps, height: railH, depth: railThick }, this.scene),
          MeshBuilder.CreateBox(`tower_rail_${id}_l`, { width: railThick, height: railH, depth: ps }, this.scene),
          MeshBuilder.CreateBox(`tower_rail_${id}_r`, { width: railThick, height: railH, depth: ps }, this.scene),
        ]
        railings[0].position.set(x, y + ph + railH / 2, z + ps / 2)
        railings[1].position.set(x, y + ph + railH / 2, z - ps / 2)
        railings[2].position.set(x - ps / 2, y + ph + railH / 2, z)
        railings[3].position.set(x + ps / 2, y + ph + railH / 2, z)
        for (const r of railings) r.material = woodMat
      }
    }

    // Cross-braces between posts for visual + stepping stones
    // Lower step — a small platform sticking out, so player can begin climbing
    const step = MeshBuilder.CreateBox(`tower_step_${id}`, {
      width: 2, height: 0.25, depth: 1.2,
    }, this.scene)
    step.position.set(x + baseW / 2 + 0.5, y + 1.2, z)
    step.material = platformMat
    this.collidable.push(step)

    // Cross braces (visual)
    for (let i = 0; i < 4; i++) {
      const brace = MeshBuilder.CreateBox(`tower_brace_${id}_${i}`, {
        width: 0.15, height: 4, depth: 0.15,
      }, this.scene)
      const ci = corners[i]
      const ni = corners[(i + 1) % 4]
      brace.position.set(
        x + (ci[0] + ni[0]) / 2,
        y + 5,
        z + (ci[1] + ni[1]) / 2,
      )
      brace.rotation.z = 0.6
      brace.rotation.y = Math.atan2(ni[0] - ci[0], ni[1] - ci[1])
      brace.material = woodMat
    }
  }

  /** Get positions where a goblin should stand on top of towers */
  getTowerTopPositions(): Vector3[] {
    const result: Vector3[] = []
    for (const camp of this.camps) {
      if (camp.hasTower) {
        // Top platform is at y + 10
        const ty = (this.ground.getHeightAtCoordinates(camp.towerPos.x, camp.towerPos.z) ?? 0) + 10.3
        result.push(new Vector3(camp.towerPos.x, ty, camp.towerPos.z))
      }
    }
    return result
  }

  /** Push a position out of any cabin it overlaps (XZ only) */
  resolveCollision(pos: Vector3): void {
    for (const b of this.cabinBounds) {
      // Transform to cabin local space
      const dx = pos.x - b.cx
      const dz = pos.z - b.cz
      const lx = dx * b.cosR - dz * b.sinR
      const lz = dx * b.sinR + dz * b.cosR
      // Check overlap
      if (Math.abs(lx) < b.halfW && Math.abs(lz) < b.halfD) {
        // Push out along axis with smallest penetration
        const overlapX = b.halfW - Math.abs(lx)
        const overlapZ = b.halfD - Math.abs(lz)
        let pushLx = 0, pushLz = 0
        if (overlapX < overlapZ) {
          pushLx = overlapX * Math.sign(lx)
        } else {
          pushLz = overlapZ * Math.sign(lz)
        }
        // Transform push back to world space
        pos.x += pushLx * b.cosR + pushLz * b.sinR
        pos.z += -pushLx * b.sinR + pushLz * b.cosR
      }
    }
  }

  dispose() {
    for (const m of this.collidable) m.dispose()
    this.collidable.length = 0
    for (const ps of this.particles) ps.dispose()
    this.particles.length = 0
  }
}
