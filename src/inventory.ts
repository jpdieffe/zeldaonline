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

// ── Spell Projectile ─────────────────────────────────────────────────────────
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
  private spellProjectiles: SpellProjectile[] = []

  // Callbacks
  private onHeal: ((amount: number) => void) | null = null
  private getPlayerPos: (() => Vector3) | null = null
  private getCameraForward: (() => Vector3) | null = null
  private getCameraPos: (() => Vector3) | null = null
  private onGetEnemies: (() => { getPosition(): Vector3; isDead(): boolean; takeDamage(n: number): void; knockBack(dir: Vector3, force: number): void }[]) | null = null
  private getPlayerHealth: (() => number) | null = null
  private getPlayerMaxHealth: (() => number) | null = null

  // Summon minion
  private summonMesh: AbstractMesh | null = null
  private summonTarget: Vector3 | null = null

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
  }) {
    this.onHeal = opts.onHeal
    this.getPlayerPos = opts.getPlayerPos
    this.getCameraForward = opts.getCameraForward
    this.getCameraPos = opts.getCameraPos
    this.onGetEnemies = opts.getEnemies
    this.getPlayerHealth = opts.getPlayerHealth
    this.getPlayerMaxHealth = opts.getPlayerMaxHealth
  }

  // ── UI ──────────────────────────────────────────────────────────────────
  private buildUI() {
    // Main inventory panel
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

    // Tooltip
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
    // Inner dot
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
      if (e.key.toLowerCase() === 'i') {
        this.toggle()
      }
      if (e.key === 'Escape' && this.targeting) {
        this.cancelTargeting()
      }
    })

    // Left-click during targeting fires spell
    const canvas = this.scene.getEngine().getRenderingCanvas()!
    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0 && this.targeting) {
        this.fireSpell()
      }
    })
  }

  toggle() {
    this.isOpen = !this.isOpen
    if (this.uiRoot) this.uiRoot.style.display = this.isOpen ? 'block' : 'none'
    if (this.isOpen) this.renderInventory()
    // Release pointer lock when inventory is open
    if (this.isOpen) document.exitPointerLock()
  }

  isInventoryOpen(): boolean { return this.isOpen }
  isTargeting(): boolean { return this.targeting }

  private renderInventory() {
    if (!this.uiRoot) return
    let html = '<div style="text-align:center;margin-bottom:8px;font-size:16px;font-weight:bold">📦 Inventory</div>'
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

    // Active buffs
    if (this.buffs.length > 0) {
      html += '<div style="margin-top:10px;border-top:1px solid #446;padding-top:8px">'
      html += '<div style="font-size:12px;color:#aab;margin-bottom:4px">Active Buffs:</div>'
      for (const b of this.buffs) {
        const def = getItem('scroll_' + b.effect)
        html += `<div style="font-size:13px">${def?.emoji ?? '✨'} ${def?.name ?? b.effect} — ${Math.ceil(b.remaining)}s</div>`
      }
      html += '</div>'
    }

    this.uiRoot.innerHTML = html

    // Attach events to slots
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
    if (!slot || !this.tooltip) return
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

  // ── Item Use ────────────────────────────────────────────────────────────
  private useItem(idx: number) {
    const slot = this.slots[idx]
    if (!slot) return
    const def = getItem(slot.itemId)
    if (!def) return

    if (def.category === 'food' || def.category === 'potion') {
      // Don't waste healing if already full
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
        this.toggle() // close inventory
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
    // Remove existing same buff
    this.buffs = this.buffs.filter(b => b.effect !== def.instantEffect)
    this.buffs.push({ effect: def.instantEffect!, remaining: def.duration, duration: def.duration })

    if (def.instantEffect === 'summon') {
      this.spawnSummon()
    }
  }

  hasBuff(effect: string): boolean {
    return this.buffs.some(b => b.effect === effect)
  }

  getBuffs(): ActiveBuff[] { return this.buffs }

  private spawnSummon() {
    if (this.summonMesh) { this.summonMesh.dispose(); this.summonMesh = null }
    const pp = this.getPlayerPos?.() ?? Vector3.Zero()
    const mesh = MeshBuilder.CreateBox('summon', { size: 1.2 }, this.scene)
    const mat = new StandardMaterial('summonMat', this.scene)
    mat.diffuseColor = new Color3(0.3, 0.9, 0.4)
    mat.alpha = 0.8
    mesh.material = mat
    mesh.position = pp.add(new Vector3(3, 0.6, 0))
    this.summonMesh = mesh
    this.summonTarget = null
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
    // Return scroll to inventory
    // (already consumed — design choice: scroll is spent on arming)
  }

  private fireSpell() {
    if (!this.targetScrollId) return
    const def = getItem(this.targetScrollId)
    if (!def || !def.spellElement) return

    const camPos = this.getCameraPos?.() ?? Vector3.Zero()
    const camFwd = this.getCameraForward?.() ?? new Vector3(0, 0, 1)

    // Spawn projectile at player position, aim forward
    const pp = this.getPlayerPos?.() ?? Vector3.Zero()
    const spawnPos = pp.add(new Vector3(0, 1.5, 0))
    const vel = camFwd.scale(40)

    const mesh = MeshBuilder.CreateSphere('spell', { diameter: 0.6 }, this.scene)
    const mat = new StandardMaterial('spellMat', this.scene)
    mat.emissiveColor = this.getSpellColor(def.spellElement)
    mat.disableLighting = true
    mesh.material = mat
    mesh.position = spawnPos.clone()

    this.spellProjectiles.push({
      mesh, velocity: vel,
      element: def.spellElement,
      damage: def.spellDamage ?? 3,
      lifetime: 3,
    })

    this.targeting = false
    this.targetScrollId = null
    if (this.crosshair) this.crosshair.style.display = 'none'
  }

  private getSpellColor(el: SpellElement): Color3 {
    switch (el) {
      case 'fire':      return new Color3(1, 0.3, 0)
      case 'water':     return new Color3(0.2, 0.4, 1)
      case 'rock':      return new Color3(0.6, 0.5, 0.3)
      case 'lightning': return new Color3(1, 1, 0.3)
      case 'grass':     return new Color3(0.2, 0.8, 0.2)
      case 'laser':     return new Color3(1, 0, 0.5)
    }
  }

  // ── Ground Items ────────────────────────────────────────────────────────
  spawnGroundItem(itemId: string, worldPos: Vector3) {
    const def = getItem(itemId)
    if (!def) return

    // Create a floating plane with the emoji as texture (use colored sphere placeholder)
    const mesh = MeshBuilder.CreateSphere(`gi_${itemId}_${Date.now()}`, { diameter: 0.5 }, this.scene)
    const mat = new StandardMaterial(`giMat_${mesh.name}`, this.scene)
    // Color based on category
    if (def.category === 'food') mat.emissiveColor = new Color3(0.2, 0.8, 0.2)
    else if (def.category === 'potion') mat.emissiveColor = new Color3(0.4, 0.2, 0.9)
    else mat.emissiveColor = new Color3(0.9, 0.7, 0.1)
    mat.disableLighting = true
    mat.alpha = 0.85
    mesh.material = mat

    const gy = this.ground.getHeightAtCoordinates(worldPos.x, worldPos.z) ?? 0
    mesh.position.set(worldPos.x, gy + 1.0, worldPos.z)

    this.groundItems.push({
      itemId, position: mesh.position.clone(), mesh, bobPhase: Math.random() * Math.PI * 2,
    })
  }

  // ── Add to Inventory ────────────────────────────────────────────────────
  addItem(itemId: string, count = 1): boolean {
    // Stack existing
    const existing = this.slots.find(s => s.itemId === itemId)
    if (existing) { existing.count += count; return true }
    if (this.slots.length >= this.maxSlots) return false // full
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

      // Spin
      gi.mesh.rotation.y += dt * 2

      // Pickup range
      const dx = pp.x - gi.position.x
      const dz = pp.z - gi.position.z
      const dist = Math.sqrt(dx * dx + dz * dz)
      if (dist < 2.5) {
        if (this.addItem(gi.itemId)) {
          gi.mesh.dispose()
          this.groundItems.splice(i, 1)
        }
      }
    }

    // Update buffs
    for (let i = this.buffs.length - 1; i >= 0; i--) {
      this.buffs[i].remaining -= dt
      if (this.buffs[i].remaining <= 0) {
        const eff = this.buffs[i].effect
        this.buffs.splice(i, 1)
        if (eff === 'summon' && this.summonMesh) {
          this.summonMesh.dispose()
          this.summonMesh = null
        }
      }
    }

    // Summon AI — chase nearest enemy
    if (this.summonMesh && this.onGetEnemies) {
      const enemies = this.onGetEnemies()
      let nearest: { getPosition(): Vector3; isDead(): boolean; takeDamage(n: number): void } | null = null
      let nearDist = 20
      for (const e of enemies) {
        if (e.isDead()) continue
        const d = Vector3.Distance(this.summonMesh.position, e.getPosition())
        if (d < nearDist) { nearDist = d; nearest = e }
      }
      if (nearest) {
        const dir = nearest.getPosition().subtract(this.summonMesh.position)
        dir.y = 0
        if (dir.length() > 0.1) dir.normalize()
        this.summonMesh.position.addInPlace(dir.scale(dt * 6))
        // Attack if close
        if (nearDist < 2) {
          nearest.takeDamage(1)
        }
      } else {
        // Follow player
        const toPlayer = pp.subtract(this.summonMesh.position)
        toPlayer.y = 0
        if (toPlayer.length() > 3) {
          toPlayer.normalize()
          this.summonMesh.position.addInPlace(toPlayer.scale(dt * 5))
        }
      }
      const sy = this.ground.getHeightAtCoordinates(this.summonMesh.position.x, this.summonMesh.position.z) ?? 0
      this.summonMesh.position.y = sy + 1.0
    }

    // Update spell projectiles
    for (let i = this.spellProjectiles.length - 1; i >= 0; i--) {
      const sp = this.spellProjectiles[i]
      sp.lifetime -= dt
      sp.mesh.position.addInPlace(sp.velocity.scale(dt))

      // Hit enemies
      if (this.onGetEnemies) {
        for (const e of this.onGetEnemies()) {
          if (e.isDead()) continue
          const d = Vector3.Distance(sp.mesh.position, e.getPosition())
          if (d < 2.5) {
            e.takeDamage(sp.damage)
            // Knockback for water
            if (sp.element === 'water') {
              const kb = sp.velocity.clone()
              kb.y = 0
              if (kb.length() > 0.01) kb.normalize()
              e.knockBack(kb, 80)
            }
            sp.lifetime = 0 // consumed
            break
          }
        }
      }

      // Ground collision
      const gy = this.ground.getHeightAtCoordinates(sp.mesh.position.x, sp.mesh.position.z) ?? 0
      if (sp.mesh.position.y < gy) sp.lifetime = 0

      if (sp.lifetime <= 0) {
        sp.mesh.dispose()
        this.spellProjectiles.splice(i, 1)
      }
    }

    // Refresh inventory UI if open
    if (this.isOpen) this.renderInventory()
  }

  // ── Debug: spawn item on ground near player ─────────────────────────────
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

    let html = '<div style="font-weight:bold;margin-bottom:6px;color:#ff8">🛠 Debug: Spawn Items</div>'
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
      }
    })
  }
}
