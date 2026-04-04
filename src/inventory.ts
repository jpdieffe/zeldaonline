import {
  Scene, Vector3, MeshBuilder, StandardMaterial, Color3,
  AbstractMesh, GroundMesh,
} from '@babylonjs/core'
import { type ItemDef, getItem, ALL_ITEMS, type SpellElement } from './items'

// ── Inventory Item Instance ──────────────────────────────────────────────────
export interface InvSlot {
  itemId: string
  count: number
}

// ── Ground Item (3D) ─────────────────────────────────────────────────────────
interface GroundItem {
  itemId: string
  position: Vector3
  mesh: AbstractMesh
  bobPhase: number
}

// ── Active Buff ──────────────────────────────────────────────────────────────
export interface ActiveBuff {
  effect: string
  remaining: number
  duration: number
}

// ── Beam (water / laser) ─────────────────────────────────────────────────────
interface BeamEffect {
  meshes: AbstractMesh[]
  direction: Vector3
  origin: Vector3
  element: SpellElement
  damage: number
  lifetime: number
  tickTimer: number
}

// ── Fire explosion ───────────────────────────────────────────────────────────
interface Explosion {
  meshes: AbstractMesh[]
  position: Vector3
  lifetime: number
  damage: number
  hitEnemies: Set<any>
}

// ── Boulder ──────────────────────────────────────────────────────────────────
interface Boulder {
  mesh: AbstractMesh
  velocity: Vector3
  lifetime: number
  damage: number
  hitEnemies: Set<any>
}

// ── Lightning strike ─────────────────────────────────────────────────────────
interface LightningStrike {
  meshes: AbstractMesh[]
  position: Vector3
  lifetime: number
  damage: number
  radius: number
  hitEnemies: Set<any>
}

// ── Vine zone ────────────────────────────────────────────────────────────────
interface VineZone {
  meshes: AbstractMesh[]
  position: Vector3
  radius: number
  lifetime: number
}

// ── Spell Projectile (fire) ──────────────────────────────────────────────────
interface SpellProjectile {
  mesh: AbstractMesh
  velocity: Vector3
  element: SpellElement
  damage: number
  lifetime: number
}

// ── Inventory + Item Manager ─────────────────────────────────────────────────
export class Inventory {
  private scene: Scene
  private ground: GroundMesh
  private slots: InvSlot[] = []
  private maxSlots = 20
  private isOpen = false
  private uiRoot: HTMLDivElement | null = null
  private tooltip: HTMLDivElement | null = null
  private groundItems: GroundItem[] = []
  private buffs: ActiveBuff[] = []

  // Spell targeting
  private targeting = false
  private targetScrollId: string | null = null
  private crosshair: HTMLDivElement | null = null

  // Active effects
  private spellProjectiles: SpellProjectile[] = []
  private beams: BeamEffect[] = []
  private explosions: Explosion[] = []
  private boulders: Boulder[] = []
  private lightningStrikes: LightningStrike[] = []
  private vineZones: VineZone[] = []

  // Callbacks
  private onHeal: ((amount: number) => void) | null = null
  private getPlayerPos: (() => Vector3) | null = null
  private getCameraForward: (() => Vector3) | null = null
  private getCameraPos: (() => Vector3) | null = null
  private onGetEnemies: (() => { getPosition(): Vector3; isDead(): boolean; takeDamage(n: number): void; knockBack(dir: Vector3, force: number): void }[]) | null = null
  private getPlayerHealth: (() => number) | null = null
  private getPlayerMaxHealth: (() => number) | null = null
  private onBuffStart: ((effect: string) => void) | null = null
  private onBuffEnd: ((effect: string) => void) | null = null

  // Summon goblin
  private summonMeshes: AbstractMesh[] = []
  private summonPivot: AbstractMesh | null = null

  constructor(scene: Scene, ground: GroundMesh) {
    this.scene = scene
    this.ground = ground
    this.buildUI()
    this.buildCrosshair()
    this.setupInput()
  }

  setCallbacks(opts: {
    onHeal: (amount: number) => void
    getPlayerPos: () => Vector3
    getCameraForward: () => Vector3
    getCameraPos: () => Vector3
    getEnemies: () => { getPosition(): Vector3; isDead(): boolean; takeDamage(n: number): void; knockBack(dir: Vector3, force: number): void }[]
    getPlayerHealth: () => number
    getPlayerMaxHealth: () => number
    onBuffStart?: (effect: string) => void
    onBuffEnd?: (effect: string) => void
  }) {
    this.onHeal = opts.onHeal
    this.getPlayerPos = opts.getPlayerPos
    this.getCameraForward = opts.getCameraForward
    this.getCameraPos = opts.getCameraPos
    this.onGetEnemies = opts.getEnemies
    this.getPlayerHealth = opts.getPlayerHealth
    this.getPlayerMaxHealth = opts.getPlayerMaxHealth
    this.onBuffStart = opts.onBuffStart ?? null
    this.onBuffEnd = opts.onBuffEnd ?? null
  }

  // ── UI ──────────────────────────────────────────────────────────────────
  private buildUI() {
    const root = document.createElement('div')
    root.id = 'inventoryPanel'
    root.style.cssText = [
      'display:none', 'position:fixed', 'top:50%', 'left:50%',
      'transform:translate(-50%,-50%)',
      'background:rgba(0,10,30,0.92)', 'border:2px solid #556',
      'border-radius:12px', 'padding:16px',
      'z-index:100', 'min-width:340px',
      'font:14px/1.4 system-ui,sans-serif', 'color:#eef',
      'user-select:none',
    ].join(';')
    document.body.appendChild(root)
    this.uiRoot = root

    const tip = document.createElement('div')
    tip.id = 'invTooltip'
    tip.style.cssText = [
      'display:none', 'position:fixed',
      'background:rgba(0,0,0,0.9)', 'border:1px solid #889',
      'border-radius:6px', 'padding:8px 12px',
      'z-index:110', 'pointer-events:none',
      'font:13px/1.4 system-ui,sans-serif', 'color:#dde',
      'max-width:220px', 'white-space:pre-wrap',
    ].join(';')
    document.body.appendChild(tip)
    this.tooltip = tip
  }

  private buildCrosshair() {
    const ch = document.createElement('div')
    ch.id = 'spellCrosshair'
    ch.style.cssText = [
      'display:none', 'position:fixed', 'top:50%', 'left:50%',
      'transform:translate(-50%,-50%)',
      'width:40px', 'height:40px',
      'border:3px solid #ff4', 'border-radius:50%',
      'z-index:90', 'pointer-events:none',
      'box-shadow:0 0 12px rgba(255,255,0,0.4)',
    ].join(';')
    const dot = document.createElement('div')
    dot.style.cssText = [
      'position:absolute', 'top:50%', 'left:50%',
      'transform:translate(-50%,-50%)',
      'width:6px', 'height:6px', 'background:#ff4', 'border-radius:50%',
    ].join(';')
    ch.appendChild(dot)
    document.body.appendChild(ch)
    this.crosshair = ch
  }

  private setupInput() {
    window.addEventListener('keydown', (e) => {
      if (e.key.toLowerCase() === 'i') this.toggle()
      if (e.key === 'Escape' && this.targeting) this.cancelTargeting()
    })
    const canvas = this.scene.getEngine().getRenderingCanvas()!
    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0 && this.targeting) this.fireSpell()
    })
  }

  toggle() {
    this.isOpen = !this.isOpen
    if (this.uiRoot) this.uiRoot.style.display = this.isOpen ? 'block' : 'none'
    if (this.isOpen) {
      this.renderInventory()
      document.exitPointerLock()
    } else {
      this.hideTooltip()
    }
  }

  isInventoryOpen(): boolean { return this.isOpen }
  isTargeting(): boolean { return this.targeting }

  private renderInventory() {
    if (!this.uiRoot) return
    let html = '<div style="text-align:center;margin-bottom:8px;font-size:16px;font-weight:bold">\uD83D\uDCE6 Inventory</div>'
    html += '<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:6px">'
    for (let i = 0; i < this.maxSlots; i++) {
      const slot = this.slots[i]
      const bg = slot ? 'rgba(60,80,120,0.7)' : 'rgba(40,40,60,0.5)'
      const cursor = slot ? 'pointer' : 'default'
      html += `<div class="inv-slot" data-idx="${i}" style="
        width:52px;height:52px;background:${bg};border:1px solid #556;border-radius:6px;
        display:flex;align-items:center;justify-content:center;font-size:28px;
        position:relative;cursor:${cursor};
      ">`
      if (slot) {
        const def = getItem(slot.itemId)
        html += def?.emoji ?? '?'
        if (slot.count > 1) {
          html += `<span style="position:absolute;bottom:1px;right:4px;font-size:11px;color:#ccc">${slot.count}</span>`
        }
      }
      html += '</div>'
    }
    html += '</div>'

    if (this.buffs.length > 0) {
      html += '<div style="margin-top:10px;border-top:1px solid #446;padding-top:8px">'
      html += '<div style="font-size:12px;color:#aab;margin-bottom:4px">Active Buffs:</div>'
      for (const b of this.buffs) {
        const def = getItem('scroll_' + b.effect)
        html += `<div style="font-size:13px">${def?.emoji ?? '\u2728'} ${def?.name ?? b.effect} \u2014 ${Math.ceil(b.remaining)}s</div>`
      }
      html += '</div>'
    }

    this.uiRoot.innerHTML = html

    const slotEls = this.uiRoot.querySelectorAll('.inv-slot')
    slotEls.forEach((el) => {
      const idx = parseInt((el as HTMLElement).dataset.idx ?? '-1')
      el.addEventListener('mouseenter', (e) => this.showTooltip(idx, e as MouseEvent))
      el.addEventListener('mousemove', (e) => this.moveTooltip(e as MouseEvent))
      el.addEventListener('mouseleave', () => this.hideTooltip())
      el.addEventListener('click', () => this.useItem(idx))
    })
  }

  private showTooltip(idx: number, e: MouseEvent) {
    const slot = this.slots[idx]
    if (!slot || !this.tooltip) { this.hideTooltip(); return }
    const def = getItem(slot.itemId)
    if (!def) return
    this.tooltip.textContent = `${def.emoji} ${def.name}\n${def.description}`
    this.tooltip.style.display = 'block'
    this.moveTooltip(e)
  }

  private moveTooltip(e: MouseEvent) {
    if (!this.tooltip) return
    this.tooltip.style.left = `${e.clientX + 14}px`
    this.tooltip.style.top = `${e.clientY + 14}px`
  }

  private hideTooltip() {
    if (this.tooltip) this.tooltip.style.display = 'none'
  }

  private refreshIfOpen() {
    if (this.isOpen) this.renderInventory()
  }

  // ── Item Use ────────────────────────────────────────────────────────────
  private useItem(idx: number) {
    const slot = this.slots[idx]
    if (!slot) return
    const def = getItem(slot.itemId)
    if (!def) return

    if (def.category === 'food' || def.category === 'potion') {
      const hp = this.getPlayerHealth?.() ?? 0
      const max = this.getPlayerMaxHealth?.() ?? 6
      if (hp >= max) return
      if (def.healAmount && this.onHeal) {
        this.onHeal(def.healAmount)
        this.removeFromSlot(idx)
        this.renderInventory()
      }
    } else if (def.category === 'scroll') {
      if (def.scrollMode === 'instant') {
        this.applyInstantScroll(def)
        this.removeFromSlot(idx)
        this.renderInventory()
      } else if (def.scrollMode === 'target') {
        this.startTargeting(def.id)
        this.removeFromSlot(idx)
        this.renderInventory()
        this.toggle()
      }
    }
  }

  private removeFromSlot(idx: number) {
    const slot = this.slots[idx]
    if (!slot) return
    slot.count--
    if (slot.count <= 0) this.slots.splice(idx, 1)
  }

  // ── Instant Scrolls ────────────────────────────────────────────────────
  private applyInstantScroll(def: ItemDef) {
    if (!def.instantEffect || !def.duration) return
    this.buffs = this.buffs.filter(b => b.effect !== def.instantEffect)
    this.buffs.push({ effect: def.instantEffect!, remaining: def.duration, duration: def.duration })

    if (def.instantEffect === 'summon') this.spawnSummon()
    this.onBuffStart?.(def.instantEffect!)
  }

  hasBuff(effect: string): boolean {
    return this.buffs.some(b => b.effect === effect)
  }

  getBuffs(): ActiveBuff[] { return this.buffs }

  // ── Summon: blue-tinted goblin follower ─────────────────────────────────
  private spawnSummon() {
    this.disposeSummon()
    const pp = this.getPlayerPos?.() ?? Vector3.Zero()
    const bodyMat = new StandardMaterial('summonMat', this.scene)
    bodyMat.diffuseColor = new Color3(0.3, 0.5, 1.0)
    bodyMat.emissiveColor = new Color3(0.1, 0.15, 0.4)
    bodyMat.alpha = 0.85

    const body = MeshBuilder.CreateCapsule('summonBody', { height: 1.6, radius: 0.35 }, this.scene)
    body.material = bodyMat
    body.position = pp.add(new Vector3(3, 0.8, 0))

    const head = MeshBuilder.CreateSphere('summonHead', { diameter: 0.55 }, this.scene)
    head.material = bodyMat
    head.parent = body
    head.position.y = 1.0

    const earL = MeshBuilder.CreateCylinder('summonEarL', { height: 0.3, diameterTop: 0, diameterBottom: 0.15 }, this.scene)
    earL.material = bodyMat; earL.parent = head; earL.position.set(-0.25, 0.15, 0); earL.rotation.z = -0.5

    const earR = MeshBuilder.CreateCylinder('summonEarR', { height: 0.3, diameterTop: 0, diameterBottom: 0.15 }, this.scene)
    earR.material = bodyMat; earR.parent = head; earR.position.set(0.25, 0.15, 0); earR.rotation.z = 0.5

    this.summonPivot = body
    this.summonMeshes = [body, head, earL, earR]
  }

  private disposeSummon() {
    for (const m of this.summonMeshes) m.dispose()
    this.summonMeshes = []
    this.summonPivot = null
  }

  // ── Target Scrolls ─────────────────────────────────────────────────────
  private startTargeting(scrollId: string) {
    this.targeting = true
    this.targetScrollId = scrollId
    if (this.crosshair) this.crosshair.style.display = 'block'
  }

  cancelTargeting() {
    this.targeting = false
    this.targetScrollId = null
    if (this.crosshair) this.crosshair.style.display = 'none'
  }

  private fireSpell() {
    if (!this.targetScrollId) return
    const def = getItem(this.targetScrollId)
    if (!def || !def.spellElement) return

    const camFwd = this.getCameraForward?.() ?? new Vector3(0, 0, 1)
    const pp = this.getPlayerPos?.() ?? Vector3.Zero()

    switch (def.spellElement) {
      case 'fire':     this.spawnFireball(pp, camFwd, def.spellDamage ?? 5); break
      case 'water':    this.spawnBeam(pp, camFwd, 'water', def.spellDamage ?? 3, 5, 0.4); break
      case 'rock':     this.spawnBoulder(pp, camFwd, def.spellDamage ?? 4); break
      case 'lightning': this.spawnLightning(pp, camFwd, def.spellDamage ?? 6); break
      case 'grass':    this.spawnVineZone(pp, camFwd); break
      case 'laser':    this.spawnBeam(pp, camFwd, 'laser', def.spellDamage ?? 8, 5, 1.2); break
    }

    this.targeting = false
    this.targetScrollId = null
    if (this.crosshair) this.crosshair.style.display = 'none'
  }

  // ── FIRE: projectile that explodes on contact ──────────────────────────
  private spawnFireball(pp: Vector3, dir: Vector3, damage: number) {
    const spawnPos = pp.add(new Vector3(0, 1.5, 0))
    const vel = dir.scale(35)
    const mesh = MeshBuilder.CreateSphere('fireball', { diameter: 0.7 }, this.scene)
    const mat = new StandardMaterial('fireballMat', this.scene)
    mat.emissiveColor = new Color3(1, 0.4, 0)
    mat.disableLighting = true
    mesh.material = mat
    mesh.position = spawnPos.clone()
    this.spellProjectiles.push({ mesh, velocity: vel, element: 'fire', damage, lifetime: 4 })
  }

  private spawnExplosion(pos: Vector3, damage: number) {
    const meshes: AbstractMesh[] = []
    const core = MeshBuilder.CreateSphere('explCore', { diameter: 3 }, this.scene)
    const coreMat = new StandardMaterial('explCoreMat', this.scene)
    coreMat.emissiveColor = new Color3(1, 0.6, 0)
    coreMat.disableLighting = true; coreMat.alpha = 0.9
    core.material = coreMat; core.position = pos.clone()
    meshes.push(core)

    const ring = MeshBuilder.CreateSphere('explRing', { diameter: 6 }, this.scene)
    const ringMat = new StandardMaterial('explRingMat', this.scene)
    ringMat.emissiveColor = new Color3(1, 0.2, 0)
    ringMat.disableLighting = true; ringMat.alpha = 0.4
    ring.material = ringMat; ring.position = pos.clone()
    meshes.push(ring)

    this.explosions.push({ meshes, position: pos.clone(), lifetime: 0.6, damage, hitEnemies: new Set() })
  }

  // ── WATER / LASER beam ─────────────────────────────────────────────────
  private spawnBeam(pp: Vector3, dir: Vector3, element: SpellElement, damage: number, duration: number, width: number) {
    const flatDir = new Vector3(dir.x, 0, dir.z)
    if (flatDir.length() > 0.01) flatDir.normalize()
    else flatDir.set(0, 0, 1)

    const beamLength = 30
    const origin = pp.add(new Vector3(0, 1.2, 0))
    const meshes: AbstractMesh[] = []
    const segCount = 10
    const segLen = beamLength / segCount

    for (let i = 0; i < segCount; i++) {
      const seg = MeshBuilder.CreateCylinder(`beam_${i}`, {
        height: segLen, diameter: width, tessellation: 8,
      }, this.scene)
      const mat = new StandardMaterial(`beamMat_${i}`, this.scene)
      if (element === 'water') {
        mat.emissiveColor = new Color3(0.2, 0.5, 1); mat.alpha = 0.6
      } else {
        mat.emissiveColor = new Color3(1, 0.1, 0.2); mat.alpha = 0.7
      }
      mat.disableLighting = true
      seg.material = mat
      const center = origin.add(flatDir.scale(segLen * (i + 0.5)))
      seg.position = center
      seg.rotation.x = Math.PI / 2
      seg.rotation.y = Math.atan2(flatDir.x, flatDir.z)
      meshes.push(seg)
    }

    this.beams.push({ meshes, direction: flatDir, origin, element, damage, lifetime: duration, tickTimer: 0 })
  }

  // ── ROCK: rolling boulder ──────────────────────────────────────────────
  private spawnBoulder(pp: Vector3, dir: Vector3, damage: number) {
    const flatDir = new Vector3(dir.x, 0, dir.z)
    if (flatDir.length() > 0.01) flatDir.normalize()
    else flatDir.set(0, 0, 1)

    const mesh = MeshBuilder.CreateSphere('boulder', { diameter: 2.5 }, this.scene)
    const mat = new StandardMaterial('boulderMat', this.scene)
    mat.diffuseColor = new Color3(0.5, 0.4, 0.3)
    mat.specularColor = new Color3(0.1, 0.1, 0.1)
    mesh.material = mat

    const gy = this.ground.getHeightAtCoordinates(pp.x, pp.z) ?? 0
    mesh.position.set(pp.x + flatDir.x * 2, gy + 1.5, pp.z + flatDir.z * 2)

    this.boulders.push({ mesh, velocity: flatDir.scale(20), lifetime: 4, damage, hitEnemies: new Set() })
  }

  // ── LIGHTNING: sky strike at targeted area ─────────────────────────────
  private spawnLightning(pp: Vector3, dir: Vector3, damage: number) {
    const flatDir = new Vector3(dir.x, 0, dir.z)
    if (flatDir.length() > 0.01) flatDir.normalize()
    else flatDir.set(0, 0, 1)

    const strikePos = pp.add(flatDir.scale(15))
    const gy = this.ground.getHeightAtCoordinates(strikePos.x, strikePos.z) ?? 0
    strikePos.y = gy

    const meshes: AbstractMesh[] = []
    const boltMat = new StandardMaterial('lBoltMat', this.scene)
    boltMat.emissiveColor = new Color3(1, 1, 0.5)
    boltMat.disableLighting = true; boltMat.alpha = 0.9

    const bolt = MeshBuilder.CreateBox('lBolt', { width: 0.5, height: 40, depth: 0.5 }, this.scene)
    bolt.material = boltMat; bolt.position.set(strikePos.x, gy + 20, strikePos.z)
    meshes.push(bolt)

    const bolt2 = MeshBuilder.CreateBox('lBolt2', { width: 0.3, height: 35, depth: 0.3 }, this.scene)
    bolt2.material = boltMat; bolt2.position.set(strikePos.x + 0.8, gy + 17, strikePos.z + 0.5)
    bolt2.rotation.z = 0.15
    meshes.push(bolt2)

    const flashMat = new StandardMaterial('lFlashMat', this.scene)
    flashMat.emissiveColor = new Color3(1, 1, 0.3)
    flashMat.disableLighting = true; flashMat.alpha = 0.6

    const flash = MeshBuilder.CreateDisc('lFlash', { radius: 6, tessellation: 24 }, this.scene)
    flash.material = flashMat; flash.position.set(strikePos.x, gy + 0.2, strikePos.z)
    flash.rotation.x = Math.PI / 2
    meshes.push(flash)

    this.lightningStrikes.push({ meshes, position: strikePos.clone(), lifetime: 0.8, damage, radius: 6, hitEnemies: new Set() })
  }

  // ── GRASS: vine trap zone ──────────────────────────────────────────────
  private spawnVineZone(pp: Vector3, dir: Vector3) {
    const flatDir = new Vector3(dir.x, 0, dir.z)
    if (flatDir.length() > 0.01) flatDir.normalize()
    else flatDir.set(0, 0, 1)

    const center = pp.add(flatDir.scale(10))
    const gy = this.ground.getHeightAtCoordinates(center.x, center.z) ?? 0
    center.y = gy

    const meshes: AbstractMesh[] = []
    const radius = 5

    const disc = MeshBuilder.CreateDisc('vineDisc', { radius, tessellation: 24 }, this.scene)
    const discMat = new StandardMaterial('vineDiscMat', this.scene)
    discMat.emissiveColor = new Color3(0.1, 0.5, 0.1)
    discMat.diffuseColor = new Color3(0.15, 0.6, 0.15)
    discMat.alpha = 0.5
    disc.material = discMat
    disc.position.set(center.x, gy + 0.15, center.z)
    disc.rotation.x = Math.PI / 2
    meshes.push(disc)

    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2
      const r = radius * 0.6 * (0.5 + Math.random() * 0.5)
      const vx = center.x + Math.cos(angle) * r
      const vz = center.z + Math.sin(angle) * r
      const vy = this.ground.getHeightAtCoordinates(vx, vz) ?? gy

      const vine = MeshBuilder.CreateCylinder(`vine_${i}`, {
        height: 1.5 + Math.random(), diameterTop: 0.05, diameterBottom: 0.2, tessellation: 6,
      }, this.scene)
      const vineMat = new StandardMaterial(`vineMat_${i}`, this.scene)
      vineMat.diffuseColor = new Color3(0.2, 0.55, 0.15)
      vineMat.emissiveColor = new Color3(0.05, 0.2, 0.05)
      vine.material = vineMat
      vine.position.set(vx, vy + 0.75, vz)
      meshes.push(vine)
    }

    this.vineZones.push({ meshes, position: center.clone(), radius, lifetime: 8 })
  }

  // ── Ground Items ────────────────────────────────────────────────────────
  spawnGroundItem(itemId: string, worldPos: Vector3) {
    const def = getItem(itemId)
    if (!def) return

    const mesh = MeshBuilder.CreateSphere(`gi_${itemId}_${Date.now()}`, { diameter: 0.5 }, this.scene)
    const mat = new StandardMaterial(`giMat_${mesh.name}`, this.scene)
    if (def.category === 'food') mat.emissiveColor = new Color3(0.2, 0.8, 0.2)
    else if (def.category === 'potion') mat.emissiveColor = new Color3(0.4, 0.2, 0.9)
    else mat.emissiveColor = new Color3(0.9, 0.7, 0.1)
    mat.disableLighting = true; mat.alpha = 0.85
    mesh.material = mat

    const gy = this.ground.getHeightAtCoordinates(worldPos.x, worldPos.z) ?? 0
    mesh.position.set(worldPos.x, gy + 1.0, worldPos.z)
    this.groundItems.push({ itemId, position: mesh.position.clone(), mesh, bobPhase: Math.random() * Math.PI * 2 })
  }

  addItem(itemId: string, count = 1): boolean {
    const existing = this.slots.find(s => s.itemId === itemId)
    if (existing) { existing.count += count; return true }
    if (this.slots.length >= this.maxSlots) return false
    this.slots.push({ itemId, count })
    return true
  }

  // ── Update (call every frame) ──────────────────────────────────────────
  update(dt: number) {
    const pp = this.getPlayerPos?.() ?? Vector3.Zero()

    // Bob ground items + pickup
    for (let i = this.groundItems.length - 1; i >= 0; i--) {
      const gi = this.groundItems[i]
      gi.bobPhase += dt * 3
      gi.mesh.position.y = gi.position.y + Math.sin(gi.bobPhase) * 0.3
      gi.mesh.rotation.y += dt * 2
      const dx = pp.x - gi.position.x
      const dz = pp.z - gi.position.z
      if (Math.sqrt(dx * dx + dz * dz) < 2.5) {
        if (this.addItem(gi.itemId)) {
          gi.mesh.dispose()
          this.groundItems.splice(i, 1)
          this.refreshIfOpen()
        }
      }
    }

    // Update buffs
    for (let i = this.buffs.length - 1; i >= 0; i--) {
      this.buffs[i].remaining -= dt
      if (this.buffs[i].remaining <= 0) {
        const eff = this.buffs[i].effect
        this.buffs.splice(i, 1)
        if (eff === 'summon') this.disposeSummon()
        this.onBuffEnd?.(eff)
      }
    }

    // Summon AI
    if (this.summonPivot && this.onGetEnemies) {
      const enemies = this.onGetEnemies()
      let nearest: { getPosition(): Vector3; isDead(): boolean; takeDamage(n: number): void } | null = null
      let nearDist = 20
      for (const e of enemies) {
        if (e.isDead()) continue
        const d = Vector3.Distance(this.summonPivot.position, e.getPosition())
        if (d < nearDist) { nearDist = d; nearest = e }
      }
      if (nearest) {
        const dir = nearest.getPosition().subtract(this.summonPivot.position)
        dir.y = 0
        if (dir.length() > 0.1) dir.normalize()
        this.summonPivot.position.addInPlace(dir.scale(dt * 6))
        if (nearDist < 2) nearest.takeDamage(1)
      } else {
        const toPlayer = pp.subtract(this.summonPivot.position)
        toPlayer.y = 0
        if (toPlayer.length() > 3) {
          toPlayer.normalize()
          this.summonPivot.position.addInPlace(toPlayer.scale(dt * 5))
        }
      }
      const sy = this.ground.getHeightAtCoordinates(this.summonPivot.position.x, this.summonPivot.position.z) ?? 0
      this.summonPivot.position.y = sy + 0.8
    }

    // Update fire projectiles
    for (let i = this.spellProjectiles.length - 1; i >= 0; i--) {
      const sp = this.spellProjectiles[i]
      sp.lifetime -= dt
      sp.mesh.position.addInPlace(sp.velocity.scale(dt))
      let exploded = false

      if (this.onGetEnemies) {
        for (const e of this.onGetEnemies()) {
          if (e.isDead()) continue
          if (Vector3.Distance(sp.mesh.position, e.getPosition()) < 2.5) {
            this.spawnExplosion(sp.mesh.position.clone(), sp.damage)
            exploded = true; break
          }
        }
      }
      if (!exploded) {
        const gy = this.ground.getHeightAtCoordinates(sp.mesh.position.x, sp.mesh.position.z) ?? 0
        if (sp.mesh.position.y < gy + 0.5) {
          this.spawnExplosion(sp.mesh.position.clone(), sp.damage)
          exploded = true
        }
      }
      if (exploded || sp.lifetime <= 0) {
        sp.mesh.dispose()
        this.spellProjectiles.splice(i, 1)
      }
    }

    // Update explosions
    for (let i = this.explosions.length - 1; i >= 0; i--) {
      const ex = this.explosions[i]
      ex.lifetime -= dt
      if (this.onGetEnemies) {
        for (const e of this.onGetEnemies()) {
          if (e.isDead() || ex.hitEnemies.has(e)) continue
          if (Vector3.Distance(ex.position, e.getPosition()) < 5) {
            e.takeDamage(ex.damage)
            ex.hitEnemies.add(e)
            const kb = e.getPosition().subtract(ex.position); kb.y = 0
            if (kb.length() > 0.01) kb.normalize()
            e.knockBack(kb, 60)
          }
        }
      }
      const alpha = Math.max(0, ex.lifetime / 0.6)
      for (const m of ex.meshes) {
        const mat = m.material as StandardMaterial
        if (mat) mat.alpha = alpha * (mat.emissiveColor.r > 0.5 ? 0.9 : 0.4)
      }
      if (ex.lifetime <= 0) {
        for (const m of ex.meshes) m.dispose()
        this.explosions.splice(i, 1)
      }
    }

    // Update beams (water / laser)
    for (let i = this.beams.length - 1; i >= 0; i--) {
      const beam = this.beams[i]
      beam.lifetime -= dt; beam.tickTimer -= dt
      const newOrigin = (this.getPlayerPos?.() ?? Vector3.Zero()).add(new Vector3(0, 1.2, 0))
      const segLen = 30 / beam.meshes.length
      for (let s = 0; s < beam.meshes.length; s++) {
        beam.meshes[s].position = newOrigin.add(beam.direction.scale(segLen * (s + 0.5)))
      }
      beam.origin = newOrigin

      if (beam.tickTimer <= 0) {
        beam.tickTimer = 0.3
        if (this.onGetEnemies) {
          for (const e of this.onGetEnemies()) {
            if (e.isDead()) continue
            const toE = e.getPosition().subtract(beam.origin); toE.y = 0
            const proj = Vector3.Dot(toE, beam.direction)
            if (proj < 0 || proj > 30) continue
            const closestPt = beam.origin.add(beam.direction.scale(proj))
            const perpDist = Vector3.Distance(e.getPosition(), closestPt)
            const hitWidth = beam.element === 'laser' ? 3 : 1.5
            if (perpDist < hitWidth) {
              e.takeDamage(beam.damage)
              if (beam.element === 'water') e.knockBack(beam.direction, 40)
            }
          }
        }
      }
      if (beam.lifetime < 1) {
        for (const m of beam.meshes) {
          const mat = m.material as StandardMaterial
          if (mat) mat.alpha = beam.lifetime * 0.7
        }
      }
      if (beam.lifetime <= 0) {
        for (const m of beam.meshes) m.dispose()
        this.beams.splice(i, 1)
      }
    }

    // Update boulders
    for (let i = this.boulders.length - 1; i >= 0; i--) {
      const b = this.boulders[i]
      b.lifetime -= dt
      b.mesh.position.x += b.velocity.x * dt
      b.mesh.position.z += b.velocity.z * dt
      const gy = this.ground.getHeightAtCoordinates(b.mesh.position.x, b.mesh.position.z) ?? 0
      b.mesh.position.y = gy + 1.3
      b.mesh.rotation.x += dt * 5; b.mesh.rotation.z += dt * 2
      b.velocity.scaleInPlace(0.995)

      if (this.onGetEnemies) {
        for (const e of this.onGetEnemies()) {
          if (e.isDead() || b.hitEnemies.has(e)) continue
          if (Vector3.Distance(b.mesh.position, e.getPosition()) < 3) {
            e.takeDamage(b.damage); b.hitEnemies.add(e)
            const kb = e.getPosition().subtract(b.mesh.position); kb.y = 0
            if (kb.length() > 0.01) kb.normalize()
            e.knockBack(kb, 80)
          }
        }
      }
      if (b.lifetime < 1) {
        b.mesh.scaling.setAll(b.lifetime)
        const mat = b.mesh.material as StandardMaterial
        if (mat) mat.alpha = b.lifetime
      }
      if (b.lifetime <= 0) { b.mesh.dispose(); this.boulders.splice(i, 1) }
    }

    // Update lightning strikes
    for (let i = this.lightningStrikes.length - 1; i >= 0; i--) {
      const ls = this.lightningStrikes[i]
      ls.lifetime -= dt
      if (this.onGetEnemies) {
        for (const e of this.onGetEnemies()) {
          if (e.isDead() || ls.hitEnemies.has(e)) continue
          const ep = e.getPosition()
          const dx = ep.x - ls.position.x, dz = ep.z - ls.position.z
          if (Math.sqrt(dx * dx + dz * dz) < ls.radius) {
            e.takeDamage(ls.damage); ls.hitEnemies.add(e)
            const kb = ep.subtract(ls.position); kb.y = 0
            if (kb.length() > 0.01) kb.normalize()
            e.knockBack(kb, 60)
          }
        }
      }
      const alpha = Math.max(0, ls.lifetime / 0.8)
      for (const m of ls.meshes) {
        const mat = m.material as StandardMaterial
        if (mat) mat.alpha = alpha * 0.9
      }
      if (ls.lifetime <= 0) {
        for (const m of ls.meshes) m.dispose()
        this.lightningStrikes.splice(i, 1)
      }
    }

    // Update vine zones
    for (let i = this.vineZones.length - 1; i >= 0; i--) {
      const vz = this.vineZones[i]
      vz.lifetime -= dt
      if (this.onGetEnemies) {
        for (const e of this.onGetEnemies()) {
          if (e.isDead()) continue
          const ep = e.getPosition()
          const dx = ep.x - vz.position.x, dz = ep.z - vz.position.z
          if (Math.sqrt(dx * dx + dz * dz) < vz.radius) {
            const pull = vz.position.subtract(ep); pull.y = 0
            if (pull.length() > 0.3) { pull.normalize(); e.knockBack(pull, 5) }
          }
        }
      }
      if (vz.lifetime < 2) {
        const alpha = vz.lifetime / 2
        for (const m of vz.meshes) {
          const mat = m.material as StandardMaterial
          if (mat) mat.alpha = Math.min(mat.alpha, alpha * 0.6)
        }
      }
      if (vz.lifetime <= 0) {
        for (const m of vz.meshes) m.dispose()
        this.vineZones.splice(i, 1)
      }
    }
  }

  debugSpawnItem(itemId: string) {
    const pp = this.getPlayerPos?.() ?? Vector3.Zero()
    const offset = new Vector3((Math.random() - 0.5) * 4, 0, (Math.random() - 0.5) * 4)
    this.spawnGroundItem(itemId, pp.add(offset))
  }

  getSlots(): InvSlot[] { return this.slots }
}

// ── Debug Menu ───────────────────────────────────────────────────────────────
export class DebugItemMenu {
  private root: HTMLDivElement
  private visible = false
  private inventory: Inventory

  constructor(inventory: Inventory) {
    this.inventory = inventory
    const root = document.createElement('div')
    root.id = 'debugItemMenu'
    root.style.cssText = [
      'display:none', 'position:fixed', 'top:60px', 'left:10px',
      'background:rgba(0,0,0,0.9)', 'border:1px solid #666',
      'border-radius:8px', 'padding:10px',
      'z-index:120', 'max-height:80vh', 'overflow-y:auto',
      'font:13px/1.6 system-ui,sans-serif', 'color:#ddd',
    ].join(';')

    let html = '<div style="font-weight:bold;margin-bottom:6px;color:#ff8">\uD83D\uDEE0 Debug: Spawn Items</div>'
    for (const item of ALL_ITEMS) {
      html += `<div class="dbg-item" data-id="${item.id}" style="cursor:pointer;padding:2px 6px;border-radius:4px" 
        onmouseover="this.style.background='rgba(100,100,200,0.4)'" 
        onmouseout="this.style.background='none'">${item.emoji} ${item.name}</div>`
    }
    root.innerHTML = html
    document.body.appendChild(root)
    this.root = root

    root.querySelectorAll('.dbg-item').forEach(el => {
      el.addEventListener('click', () => {
        const id = (el as HTMLElement).dataset.id
        if (id) this.inventory.debugSpawnItem(id)
      })
    })

    window.addEventListener('keydown', (e) => {
      if (e.key === '`' || e.key === '~') {
        this.visible = !this.visible
        root.style.display = this.visible ? 'block' : 'none'
        if (this.visible) {
          document.exitPointerLock()
        } else {
          const canvas = document.getElementById('renderCanvas') as HTMLCanvasElement | null
          canvas?.requestPointerLock()
        }
      }
    })
  }
}
