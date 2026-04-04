import '@babylonjs/loaders/glTF'
import {
  Scene,
  Vector3,
  ArcRotateCamera,
  SceneLoader,
  TransformNode,
  AnimationGroup,
  GroundMesh,
  AbstractMesh,
  TrailMesh,
  StandardMaterial,
  Color3,
  Ray,
  Mesh,
} from '@babylonjs/core'
import type { AnimState, PlayerState } from './types'

// ── Constants ────────────────────────────────────────────────────────────────
const GRAVITY       = -28
const JUMP_VELOCITY = 12
const WALK_SPEED    = 3.5
const JOG_SPEED     = 5.5
const RUN_SPEED     = 9.0
const PLAYER_HEIGHT = 1.8
const TERMINAL_VEL  = -40
const WATER_Y       = -0.4    // swim threshold
const MODEL_SCALE   = 1.0

const CAM_RADIUS     = 12
const CAM_MIN_RADIUS = 2
const CAM_MAX_RADIUS = 30

const SPAWN = new Vector3(0, 0, 0)

// Maps our AnimState ids to the actual animation names baked in player.glb
const ANIM_NAME_MAP: Record<AnimState, string> = {
  idle:            'Idle_Loop',
  walk:            'Walk_Loop',
  jog:             'Jog_Fwd_Loop',
  run:             'Run Anime',
  jump_start:      'Jump_Start',
  jump_loop:       'Jump_Loop',
  jump_land:       'Jump_Land',
  roll:            'Roll',
  crouch_idle:     'Crouch_Idle_Loop',
  crouch_fwd:      'Crouch_Fwd_Loop',
  swim_idle:       'Swim_Idle_Loop',
  swim_fwd:        'Swim_Fwd_Loop',
  sword_idle:      'Sword_Idle',
  sword_attack_a:  'Sword_Regular_A',
  sword_attack_b:  'Sword_Regular_B',
  sword_attack_c:  'Sword_Regular_C',
  sword_dash:      'Sword_Dash_RM',
  melee_hook:      'Melee_Hook',
  defend:          'Defend',
  hit:             'Hit_Knockback',
  death:           'Death01',
  backflip:        'Backflip',
  fighting_idle:   'Fighting Idle',
  fighting_jab_l:  'Fighting Left Jab',
  fighting_jab_r:  'Fighting Right Jab',
}

// One-shot (non-looping) animations
const ONE_SHOT: Set<AnimState> = new Set([
  'jump_start', 'jump_land', 'roll', 'backflip',
  'sword_attack_a', 'sword_attack_b', 'sword_attack_c',
  'sword_dash', 'melee_hook', 'hit', 'death',
  'fighting_jab_l', 'fighting_jab_r',
])

export class Player {
  private scene: Scene
  private ground: GroundMesh
  private collidableMeshes: Mesh[] = []

  position = SPAWN.clone()
  private velocity = Vector3.Zero()
  private onGround = true
  facingY = 0

  camera!: ArcRotateCamera

  // Input
  private keys = new Set<string>()
  private mouseLeft = false
  private mouseRight = false

  // Model
  private modelPivot: TransformNode | null = null  // parent we rotate
  private modelRoot: TransformNode | null = null    // GLB __root__ inside pivot
  private animGroups = new Map<AnimState, AnimationGroup>()
  private animDurations = new Map<AnimState, number>()
  private currentAnim: AnimState = 'idle'
  private animsLoaded = false

  // Skin swap
  private skinNames = ['player', 'link']
  private skinScales = [MODEL_SCALE, MODEL_SCALE * 2]
  private skinIndex = 1
  private skinRoots: TransformNode[] = []
  private skinMeshSets: AbstractMesh[][] = []
  private skinAnimSets: Map<AnimState, AnimationGroup>[] = []
  private skinDurationSets: Map<AnimState, number>[] = []

  // Combat
  private swordComboIndex = 0               // 0-2 cycles through A, B, C
  private comboRound = 0                    // 0 = first round (full speed), 1+ = slow
  private comboTimer = 0                    // time left to chain next combo
  private attackLock = false                // true while playing attack anim
  private attackLockTimer = 0
  private attackDuration = 0                 // initial duration for progress calc
  private isDefendingState = false

  // Roll
  private rolling = false
  private rollDir = Vector3.Zero()

  // Sword
  private swordMeshes: AbstractMesh[] = []
  private swordRoot: TransformNode | null = null
  private swordGlbRoot: TransformNode | null = null
  private swordTipNode: TransformNode | null = null
  private slashTrail: TrailMesh | null = null
  private trailMat: StandardMaterial | null = null
  private trailWidth = 0.35
  swordEquipped = true

  // Shield
  private shieldRoot: TransformNode | null = null
  private shieldMeshes: AbstractMesh[] = []
  shieldEquipped = true

  // Thrown sword
  private thrownActive = false
  private thrownPivot: TransformNode | null = null
  private thrownPos = Vector3.Zero()
  private thrownVel = Vector3.Zero()
  private thrownBounces = 0
  private thrownLifetime = 0

  // Jump state machine
  private jumpPhase: 'none' | 'start' | 'loop' | 'land' = 'none'
  private jumpPhaseTimer = 0

  // Swimming
  private swimming = false

  // Sprint
  private sprinting = false
  private dashing = false
  private dashDir = Vector3.Zero()
  private dashStartPos = Vector3.Zero()
  private dashPhase: 'forward' | 'reverse' = 'forward'
  private dashForwardTime = 0

  // Debug mode
  private debugMode = false
  private debugDefend = false

  // Health
  private maxHealth = 6
  private health = 6
  private dead = false
  private respawnTimer = 0
  private iframeTimer = 0  // invincibility after taking damage
  private damageFlashTimer = 0
  private knockbackTimer = 0

  constructor(scene: Scene, ground: GroundMesh) {
    this.scene = scene
    this.ground = ground
    // Find a dry starting position
    this.position = this.findDrySpawn()
    this.setupCamera()
    this.setupInput()
    this.loadModel()
  }

  private getGroundY(x: number, z: number): number {
    const y = this.ground.getHeightAtCoordinates(x, z)
    return (y != null && isFinite(y)) ? y : 0
  }

  /** Get the highest surface Y at (x,z) including terrain and collidable structures */
  private getSurfaceY(x: number, z: number, playerY: number): number {
    let best = this.getGroundY(x, z)
    if (this.collidableMeshes.length === 0) return best
    // Raycast down from above the player to find platforms
    const origin = new Vector3(x, playerY + 2, z)
    const ray = new Ray(origin, Vector3.Down(), 50)
    for (const mesh of this.collidableMeshes) {
      const hit = ray.intersectsMesh(mesh, false)
      if (hit.hit && hit.pickedPoint) {
        const py = hit.pickedPoint.y
        // Only count surfaces that are below or at player feet (not above head)
        if (py <= playerY + 0.5 && py > best) {
          best = py
        }
      }
    }
    return best
  }

  setCollidableMeshes(meshes: Mesh[]) {
    this.collidableMeshes = meshes
  }

  private wallCollider: ((pos: Vector3) => void) | null = null
  setWallCollider(fn: (pos: Vector3) => void) {
    this.wallCollider = fn
  }

  setPosition(x: number, y: number, z: number) {
    this.position.set(x, y, z)
  }

  // ── Camera ────────────────────────────────────────────────────────────────
  private setupCamera() {
    const cam = new ArcRotateCamera('cam', -Math.PI / 2, 1.0, CAM_RADIUS, SPAWN.clone(), this.scene)
    cam.lowerRadiusLimit  = CAM_MIN_RADIUS
    cam.upperRadiusLimit  = CAM_MAX_RADIUS
    cam.lowerBetaLimit    = 0.15
    cam.upperBetaLimit    = Math.PI * 0.48   // don't let camera go underground

    cam.panningSensibility = 0
    cam.inputs.removeByType('ArcRotateCameraKeyboardMoveInput')
    cam.inputs.removeByType('ArcRotateCameraPointersInput')

    const canvas = this.scene.getEngine().getRenderingCanvas()!
    cam.attachControl(canvas, true)
    this.camera = cam

    canvas.addEventListener('click', () => canvas.requestPointerLock())

    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== canvas) return
      const sens = 0.004
      cam.alpha -= e.movementX * sens
      cam.beta  -= e.movementY * sens
      const bLo = cam.lowerBetaLimit ?? 0.15
      const bHi = cam.upperBetaLimit ?? Math.PI * 0.48
      if (cam.beta < bLo) cam.beta = bLo
      if (cam.beta > bHi) cam.beta = bHi
    })

    // Scroll-wheel zoom
    canvas.addEventListener('wheel', (e) => {
      cam.radius += e.deltaY * 0.01
      if (cam.radius < CAM_MIN_RADIUS) cam.radius = CAM_MIN_RADIUS
      if (cam.radius > CAM_MAX_RADIUS) cam.radius = CAM_MAX_RADIUS
    })
  }

  // ── Input ─────────────────────────────────────────────────────────────────
  private setupInput() {
    window.addEventListener('keydown', (e) => {
      this.keys.add(e.key.toLowerCase())
      if (e.key.toLowerCase() === 'shift') this.sprinting = true
      if (e.key === '1' && !this.swordEquipped) {
        this.swordEquipped = true
        this.setSwordVisible(true)
      }
      if (e.key === '2' && this.swordEquipped) {
        this.swordEquipped = false
        this.setSwordVisible(false)
      }
      if (e.key.toLowerCase() === 'r' && this.swordEquipped && !this.thrownActive) {
        this.throwSword()
      }
      if (e.key.toLowerCase() === 't') {
        this.debugMode = !this.debugMode
        this.debugDefend = false
        const panel = document.getElementById('debugPanel') as HTMLElement | null
        if (panel) panel.style.display = this.debugMode ? 'block' : 'none'
        if (this.debugMode) {
          this.shieldEquipped = true
          this.setShieldVisible(true)
        }
      }
      if (e.key.toLowerCase() === 'y') {
        this.debugMode = !this.debugMode
        this.debugDefend = this.debugMode
        const panel = document.getElementById('debugPanel') as HTMLElement | null
        if (panel) panel.style.display = this.debugMode ? 'block' : 'none'
        if (this.debugMode) {
          this.shieldEquipped = true
          this.setShieldVisible(true)
        }
      }
      if (e.key === '3' && this.animsLoaded) {
        this.switchSkin((this.skinIndex + 1) % this.skinNames.length)
      }
      if (e.key === '4') {
        this.shieldEquipped = !this.shieldEquipped
        this.setShieldVisible(this.shieldEquipped)
      }
    })
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.key.toLowerCase())
      if (e.key.toLowerCase() === 'shift') this.sprinting = false
    })
    const canvas = this.scene.getEngine().getRenderingCanvas()!
    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.mouseLeft = true
      if (e.button === 2) this.mouseRight = true
    })
    canvas.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseLeft = false
      if (e.button === 2) this.mouseRight = false
    })
    canvas.addEventListener('contextmenu', (e) => e.preventDefault())
  }

  // ── Model ─────────────────────────────────────────────────────────────────
  private async loadModel() {
    this.modelPivot = new TransformNode('playerPivot', this.scene)

    // Load all skins
    for (let si = 0; si < this.skinNames.length; si++) {
      const skinName = this.skinNames[si]
      const result = await SceneLoader.ImportMeshAsync('', './assets/player/', `${skinName}.glb`, this.scene)
      const root = result.meshes[0] as unknown as TransformNode
      root.parent = this.modelPivot
      root.scaling.setAll(this.skinScales[si])
      this.skinRoots.push(root)
      this.skinMeshSets.push(result.meshes.slice(1) as AbstractMesh[])

      const anims = new Map<AnimState, AnimationGroup>()
      const durs = new Map<AnimState, number>()
      for (const [state, glbName] of Object.entries(ANIM_NAME_MAP) as [AnimState, string][]) {
        const group = result.animationGroups.find(g => g.name === glbName)
        if (group) {
          group.stop()
          group.loopAnimation = !ONE_SHOT.has(state)
          anims.set(state, group)
          const fps = group.targetedAnimations[0]?.animation.framePerSecond ?? 30
          durs.set(state, (group.to - group.from) / fps)
        }
      }
      this.skinAnimSets.push(anims)
      this.skinDurationSets.push(durs)
    }

    // Activate link skin by default
    this.switchSkin(1)
    this.animsLoaded = true
    this.playAnim('idle')

    // Load sword and attach to hand bone
    await this.loadSword()
  }

  private switchSkin(index: number) {
    // Stop current anims
    const prevAnims = this.skinAnimSets[this.skinIndex]
    if (prevAnims) {
      const prev = prevAnims.get(this.currentAnim)
      if (prev) prev.stop()
    }

    // Hide all skins
    for (let i = 0; i < this.skinRoots.length; i++) {
      for (const m of this.skinMeshSets[i]) m.isVisible = false
    }

    this.skinIndex = index
    this.modelRoot = this.skinRoots[index]
    this.animGroups = this.skinAnimSets[index]
    this.animDurations = this.skinDurationSets[index]

    // Show active skin
    for (const m of this.skinMeshSets[index]) m.isVisible = true

    // Re-attach sword to new skeleton's hand_r
    if (this.swordRoot) {
      const handBone = this.modelRoot.getChildTransformNodes(false)
        .find(n => n.name === 'hand_r')
      if (handBone) this.swordRoot.parent = handBone
    }
    // Re-attach shield to new skeleton's hand_l
    if (this.shieldRoot) {
      const handBone = this.modelRoot.getChildTransformNodes(false)
        .find(n => n.name === 'hand_l')
      if (handBone) this.shieldRoot.parent = handBone
    }

    // Restart current anim on new skin
    const cur = this.currentAnim
    this.currentAnim = 'idle' // force playAnim to actually play
    if (this.animsLoaded) this.playAnim(cur)
  }

  private async loadSword() {
    const handBone = this.skinRoots[this.skinIndex].getChildTransformNodes(false)
      .find(n => n.name === 'hand_r')
    if (!handBone) { console.warn('hand_r bone not found'); return }

    // Intermediate pivot so we can freely rotate/position
    this.swordRoot = new TransformNode('swordPivot', this.scene)
    this.swordRoot.parent = handBone
    this.swordRoot.position.set(0, 0.35, 0.25)
    this.swordRoot.rotation.set(2.3, 0, 0)

    const result = await SceneLoader.ImportMeshAsync('', './assets/weapons/', 'sword.glb', this.scene)
    const glbRoot = result.meshes[0] as unknown as TransformNode
    glbRoot.parent = this.swordRoot
    glbRoot.position.set(0, 0, 0)
    glbRoot.rotation.set(0, 0, 0)
    glbRoot.scaling.setAll(1)
    this.swordGlbRoot = glbRoot

    // Tip node extends past the sword for trail + extra reach
    this.swordTipNode = new TransformNode('swordTip', this.scene)
    this.swordTipNode.parent = this.swordRoot
    this.swordTipNode.position.set(-0.1, 0.35, -0.5)
    this.swordTipNode.rotation.set(-0.65, -0.5, 0.55)

    // Trail mesh follows the tip node
    this.slashTrail = new TrailMesh('slashTrail', this.swordTipNode, this.scene, 0.2, 30, true)
    this.trailMat = new StandardMaterial('slashTrailMat', this.scene)
    this.trailMat.emissiveColor = new Color3(0.9, 0.95, 1.0)
    this.trailMat.diffuseColor = new Color3(0.7, 0.85, 1.0)
    this.trailMat.specularColor = new Color3(0, 0, 0)
    this.trailMat.alpha = 0.5
    this.trailMat.backFaceCulling = false
    this.slashTrail.material = this.trailMat
    this.slashTrail.isVisible = false

    this.swordMeshes = result.meshes.filter(m => m !== result.meshes[0])
    // Start visible (sword equipped by default)
    this.setSwordVisible(true)

    // Load shield and attach to left hand
    await this.loadShield()
  }

  private async loadShield() {
    const handBone = this.skinRoots[this.skinIndex].getChildTransformNodes(false)
      .find(n => n.name === 'hand_l')
    if (!handBone) { console.warn('hand_l bone not found'); return }

    this.shieldRoot = new TransformNode('shieldPivot', this.scene)
    this.shieldRoot.parent = handBone
    this.shieldRoot.position.set(0, 0, 0)
    this.shieldRoot.rotation.set(0.3, 1.65, 2.65)
    this.shieldRoot.scaling.setAll(0.5)

    const result = await SceneLoader.ImportMeshAsync('', './assets/shields/', 'silver_shield.glb', this.scene)
    const glbRoot = result.meshes[0] as unknown as TransformNode
    glbRoot.parent = this.shieldRoot
    glbRoot.position.set(0, 0, 0)
    glbRoot.rotation.set(0, 0, 0)
    glbRoot.scaling.setAll(1)

    this.shieldMeshes = result.meshes.filter(m => m !== result.meshes[0])
    this.setShieldVisible(true)
  }

  private setSwordVisible(visible: boolean) {
    for (const m of this.swordMeshes) m.isVisible = visible
  }

  private setShieldVisible(visible: boolean) {
    for (const m of this.shieldMeshes) m.isVisible = visible
  }

  private playAnim(a: AnimState, speedRatio = 1.0) {
    if (a === this.currentAnim || !this.animsLoaded) return
    const prev = this.animGroups.get(this.currentAnim)
    if (prev) prev.stop()
    const next = this.animGroups.get(a)
    if (next) {
      next.start(next.loopAnimation, speedRatio, next.from, next.to, false)
    }
    this.currentAnim = a
  }

  // ── Update ────────────────────────────────────────────────────────────────
  update(dt: number) {
    // Respawn timer
    if (this.dead) {
      this.respawnTimer -= dt
      if (this.respawnTimer <= 0) this.respawn()
      return
    }
    if (this.iframeTimer > 0) this.iframeTimer -= dt

    // Damage flash timer — red tint fades, then blink during remaining iframes
    if (this.damageFlashTimer > 0) {
      this.damageFlashTimer -= dt
      if (this.damageFlashTimer <= 0) {
        this.applyDamageFlash(false)
      }
    }
    // Blink mesh during iframes
    if (this.iframeTimer > 0 && this.skinMeshSets[this.skinIndex]) {
      const visible = Math.floor(this.iframeTimer * 10) % 2 === 0
      for (const m of this.skinMeshSets[this.skinIndex]) m.isVisible = visible
    } else if (this.skinMeshSets[this.skinIndex]) {
      for (const m of this.skinMeshSets[this.skinIndex]) m.isVisible = true
    }

    this.updateTimers(dt)

    // ── Attack input (requires sword equipped) ───────────────────────────
    if (this.mouseLeft && !this.attackLock && this.onGround && !this.swimming && this.swordEquipped) {
      if (this.sprinting) {
        this.startDashAttack()
      } else {
        this.startAttack()
      }
    }
    // Air attack: sword_attack_c while airborne
    if (this.mouseLeft && !this.attackLock && !this.onGround && !this.swimming && this.swordEquipped) {
      this.attackLock = true
      this.attackLockTimer = (this.animDurations.get('sword_attack_c') ?? 0.7) * 0.7
      this.playAnim('sword_attack_c')
    }

    // ── Defend ────────────────────────────────────────────────────────────
    this.isDefendingState = this.mouseRight && this.onGround && !this.attackLock && !this.swimming
    // Debug Y-mode: override defend state after normal logic
    if (this.debugMode && this.debugDefend) {
      this.isDefendingState = true
    }

    // ── Roll / backflip ───────────────────────────────────────────────────
    if (this.keys.has('q') && this.onGround && !this.attackLock && !this.swimming) {
      this.keys.delete('q')
      this.attackLock = true
      this.rolling = true
      // Capture facing direction at roll start
      const rdx = this.position.x - this.camera.position.x
      const rdz = this.position.z - this.camera.position.z
      this.rollDir = new Vector3(rdx, 0, rdz).normalize()
      // 2x anim speed → halve the lock timer
      this.attackLockTimer = ((this.animDurations.get('roll') ?? 0.8) * 0.7) / 2
      this.playAnim('roll', 2.0)
    }

    // ── Horizontal movement ───────────────────────────────────────────────
    let moveX = 0, moveZ = 0
    if (this.keys.has('w') || this.keys.has('arrowup'))    moveZ += 1
    if (this.keys.has('s') || this.keys.has('arrowdown'))  moveZ -= 1
    if (this.keys.has('a') || this.keys.has('arrowleft'))  moveX -= 1
    if (this.keys.has('d') || this.keys.has('arrowright')) moveX += 1

    // Derive forward from actual camera→player vector (single source of truth)
    const dx = this.position.x - this.camera.position.x
    const dz = this.position.z - this.camera.position.z
    const forward = new Vector3(dx, 0, dz).normalize()
    const right   = new Vector3(forward.z, 0, -forward.x)

    const moveDir = forward.scale(moveZ).add(right.scale(moveX))
    const moving  = moveDir.length() > 0.01
    if (moving) moveDir.normalize()

    // Facing = same forward direction (always show player's back)
    if (!this.attackLock) {
      this.facingY = Math.atan2(forward.x, forward.z) + Math.PI
    }

    // Speed selection
    let speed = WALK_SPEED
    if (this.sprinting)  speed = RUN_SPEED
    else if (moving)     speed = JOG_SPEED
    if (this.isDefendingState) speed = WALK_SPEED * 0.25
    else if (this.attackLock && !this.rolling && !this.dashing) {
      speed = this.comboRound === 0 ? speed : WALK_SPEED * 0.25
    }
    if (this.swimming) speed = this.sprinting ? JOG_SPEED : WALK_SPEED

    // Rolling overrides: lunge forward in the facing direction
    if (this.rolling) {
      this.velocity.x = this.rollDir.x * RUN_SPEED
      this.velocity.z = this.rollDir.z * RUN_SPEED
    } else if (this.dashing) {
      // Dash decelerates over time (friction)
      this.velocity.x *= 0.92
      this.velocity.z *= 0.92
    } else if (this.knockbackTimer > 0) {
      // Knockback: decay velocity, don't allow player input to override
      this.knockbackTimer -= dt
      this.velocity.x *= 0.92
      this.velocity.z *= 0.92
    } else {
      this.velocity.x = moveDir.x * speed
      this.velocity.z = moveDir.z * speed
    }

    // ── Jump ──────────────────────────────────────────────────────────────
    if (this.keys.has(' ') && this.onGround && !this.attackLock && !this.swimming) {
      this.velocity.y = JUMP_VELOCITY
      this.onGround = false
      this.jumpPhase = 'start'
      this.jumpPhaseTimer = 0.25
      this.playAnim('jump_start')
    }

    // ── Gravity / ground ──────────────────────────────────────────────────
    if (!this.onGround) {
      this.velocity.y += GRAVITY * dt
      if (this.velocity.y < TERMINAL_VEL) this.velocity.y = TERMINAL_VEL
    }

    this.position.addInPlace(this.velocity.scale(dt))

    // Push out of cabin walls
    if (this.wallCollider) this.wallCollider(this.position)

    // Land on ground or structure
    const groundY = this.getSurfaceY(this.position.x, this.position.z, this.position.y)
    if (this.position.y <= groundY && this.velocity.y <= 0) {
      this.position.y = groundY
      this.velocity.y = 0
      if (!this.onGround) {
        this.onGround = true
        // Skip landing anim if mid-attack (air attack finishes first)
        if (!this.attackLock) {
          this.jumpPhase = 'land'
          this.jumpPhaseTimer = 0.2
          this.playAnim('jump_land')
        } else {
          this.jumpPhase = 'none'
        }
      }
    }

    // Grounded surface following
    if (this.onGround) {
      const surfY = this.getSurfaceY(this.position.x, this.position.z, this.position.y)
      if (this.position.y > surfY + 0.5) {
        // ground dropped away, start falling
        this.onGround = false
        this.velocity.y = 0
      } else {
        this.position.y = surfY
      }
    }

    // ── Swimming detection ────────────────────────────────────────────────
    this.swimming = this.position.y <= WATER_Y

    // ── Thrown sword ──────────────────────────────────────────────────────
    this.updateThrownSword(dt)

    // ── Animation state machine ───────────────────────────────────────────
    this.updateAnimation(moving)

    // ── Sync model ────────────────────────────────────────────────────────
    if (this.modelPivot) {
      this.modelPivot.position.copyFrom(this.position)
      // Sink model to waist level when swimming
      if (this.swimming) this.modelPivot.position.y -= PLAYER_HEIGHT * 0.45
      this.modelPivot.rotation.y = this.facingY
      // Reset modelRoot position to prevent root-motion animations from displacing the model
      if (this.modelRoot) {
        this.modelRoot.position.set(0, 0, 0)
      }
    }

    // ── Slash trail visibility ─────────────────────────────────────────────
    if (this.slashTrail) {
      const showTrail = this.isAttacking()
      this.slashTrail.isVisible = showTrail
      if (!showTrail) this.slashTrail.start()
    }

    // ── Debug: apply slider values to shieldRoot ────────────────────────────
    if (this.debugMode && this.shieldRoot) {
      const gv = (id: string) => parseFloat((document.getElementById(id) as HTMLInputElement)?.value ?? '0')
      this.shieldRoot.position.set(gv('dbgShX'), gv('dbgShY'), gv('dbgShZ'))
      this.shieldRoot.rotation.set(gv('dbgShRX'), gv('dbgShRY'), gv('dbgShRZ'))
      const sc = gv('dbgShSc')
      if (sc > 0) this.shieldRoot.scaling.setAll(sc)
    } else if (this.shieldRoot) {
      // Switch shield rotation based on defend state
      if (this.isDefendingState) {
        this.shieldRoot.rotation.set(-0.4, 1.55, 1.15)
      } else {
        this.shieldRoot.rotation.set(0.3, 1.65, 2.65)
      }
    }

    // ── Camera follow ─────────────────────────────────────────────────────
    const headY = this.position.y + PLAYER_HEIGHT * 0.8
    this.camera.target.set(this.position.x, headY, this.position.z)
  }

  private updateTimers(dt: number) {
    if (this.attackLockTimer > 0) {
      this.attackLockTimer -= dt
      if (this.attackLockTimer <= 0) {
        this.attackLock = false
        this.rolling = false
        this.dashing = false
        this.attackLockTimer = 0
      }
    }
    if (this.comboTimer > 0) {
      this.comboTimer -= dt
      if (this.comboTimer <= 0) {
        this.swordComboIndex = 0
        this.comboRound = 0
      }
    }
    if (this.jumpPhaseTimer > 0) {
      this.jumpPhaseTimer -= dt
      if (this.jumpPhaseTimer <= 0) {
        if (this.jumpPhase === 'start') this.jumpPhase = 'loop'
        else if (this.jumpPhase === 'land') this.jumpPhase = 'none'
      }
    }
  }

  private startAttack() {
    const attacks: AnimState[] = ['sword_attack_a', 'sword_attack_b', 'sword_attack_c']
    const anim = attacks[this.swordComboIndex % 3]
    const duration = (this.animDurations.get(anim) ?? 0.7) * 0.7  // cut tail
    this.attackLock = true
    this.attackLockTimer = duration
    this.attackDuration = duration
    this.comboTimer = duration + 0.3
    const nextIndex = (this.swordComboIndex + 1) % 3
    if (nextIndex < this.swordComboIndex) this.comboRound++
    this.swordComboIndex = nextIndex
    this.playAnim(anim)
  }

  private startDashAttack() {
    const duration = (this.animDurations.get('sword_attack_b') ?? 0.7) * 0.7
    this.attackLock = true
    this.attackLockTimer = duration
    this.attackDuration = duration
    this.dashing = true
    // Capture facing direction for the dash lunge
    const dx = this.position.x - this.camera.position.x
    const dz = this.position.z - this.camera.position.z
    this.dashDir = new Vector3(dx, 0, dz).normalize()
    // Forward lunge impulse — fast dash
    this.velocity.x = this.dashDir.x * RUN_SPEED * 5.5
    this.velocity.z = this.dashDir.z * RUN_SPEED * 5.5
    this.playAnim('sword_attack_b')
  }

  private updateAnimation(moving: boolean) {
    // Attack/roll lock takes priority
    if (this.attackLock) return

    // Jump phases
    if (this.jumpPhase === 'start') return  // playing jump_start
    if (this.jumpPhase === 'loop') { this.playAnim('jump_loop'); return }
    if (this.jumpPhase === 'land')  return  // playing jump_land

    if (!this.onGround) {
      this.playAnim(this.velocity.y > 0 ? 'jump_loop' : 'jump_loop')
      return
    }

    // Swimming
    if (this.swimming) {
      this.playAnim(moving ? 'swim_fwd' : 'swim_idle')
      return
    }

    // Defend
    if (this.isDefendingState) { this.playAnim('defend'); return }

    // Ground movement
    if (moving) {
      if (this.sprinting) this.playAnim('run')
      else                this.playAnim('jog')
    } else {
      this.playAnim('idle')
    }
  }

  // ── Thrown Sword ───────────────────────────────────────────────────────
  private throwSword() {
    if (!this.swordGlbRoot || !this.modelPivot) return

    this.swordEquipped = false
    this.thrownActive = true
    this.thrownBounces = 0
    this.thrownLifetime = 0

    // Create throw pivot in world space
    this.thrownPivot = new TransformNode('thrownSword', this.scene)
    this.thrownPos = this.position.clone()
    this.thrownPos.y += PLAYER_HEIGHT * 0.7

    // Launch in facing direction (camera→player forward)
    const dx = this.position.x - this.camera.position.x
    const dz = this.position.z - this.camera.position.z
    const throwDir = new Vector3(dx, 0, dz).normalize()
    const THROW_SPEED = 25
    this.thrownVel = throwDir.scale(THROW_SPEED)
    this.thrownVel.y = 3 // slight upward arc

    // Reparent sword meshes to throw pivot
    this.swordGlbRoot.parent = this.thrownPivot
    this.swordGlbRoot.position.set(0, 0, 0)
    this.swordGlbRoot.rotation.set(0, 0, 0)
    this.swordGlbRoot.scaling.setAll(1)

    for (const m of this.swordMeshes) m.isVisible = true
    this.thrownPivot.position.copyFrom(this.thrownPos)
  }

  private updateThrownSword(dt: number) {
    if (!this.thrownActive || !this.thrownPivot) return

    const THROWN_GRAVITY = -15
    const SPIN_SPEED = 25
    const BOUNCE_FACTOR = 0.4

    // Apply gravity
    this.thrownVel.y += THROWN_GRAVITY * dt

    // Move
    this.thrownPos.addInPlace(this.thrownVel.scale(dt))

    // Ground check
    const groundY = this.getGroundY(this.thrownPos.x, this.thrownPos.z)
    if (this.thrownPos.y <= groundY && this.thrownVel.y < 0) {
      this.thrownBounces++
      if (this.thrownBounces >= 2) {
        this.thrownPos.y = groundY
        this.thrownVel.set(0, 0, 0)
      } else {
        this.thrownPos.y = groundY
        this.thrownVel.y = Math.abs(this.thrownVel.y) * BOUNCE_FACTOR
        this.thrownVel.x *= 0.5
        this.thrownVel.z *= 0.5
      }
    }

    // Spin
    this.thrownPivot.rotation.x += SPIN_SPEED * dt

    // Sync position
    this.thrownPivot.position.copyFrom(this.thrownPos)

    // Auto-recall after landing
    if (this.thrownBounces >= 2) {
      this.thrownLifetime += dt
      if (this.thrownLifetime > 2.0) {
        this.recallSword()
      }
    }
  }

  private recallSword() {
    if (!this.thrownPivot || !this.swordGlbRoot || !this.swordRoot) return

    this.swordGlbRoot.parent = this.swordRoot
    this.swordGlbRoot.position.set(0, 0, 0)
    this.swordGlbRoot.rotation.set(0, 0, 0)
    this.swordGlbRoot.scaling.setAll(1)

    this.thrownPivot.dispose()
    this.thrownPivot = null
    this.thrownActive = false
    this.swordEquipped = true
    this.setSwordVisible(true)
  }

  // ── Public API ────────────────────────────────────────────────────────────
  getState(): PlayerState {
    return {
      x: this.position.x,
      y: this.position.y,
      z: this.position.z,
      ry: this.facingY,
      anim: this.currentAnim,
      sword: this.swordEquipped,
      shield: this.shieldEquipped,
      skin: this.skinNames[this.skinIndex],
    }
  }

  getPosition(): Vector3 { return this.position.clone() }

  isAttacking(): boolean {
    return this.attackLock && (
      this.currentAnim === 'sword_attack_a' ||
      this.currentAnim === 'sword_attack_b' ||
      this.currentAnim === 'sword_attack_c'
    )
  }

  /** 0 = start, 1 = end of attack animation */
  getAttackProgress(): number {
    if (this.attackDuration <= 0) return 1
    return 1 - (this.attackLockTimer / this.attackDuration)
  }

  isDashing(): boolean {
    return this.attackLock && this.dashing
  }

  isDefending(): boolean {
    return this.isDefendingState
  }

  /** True if defending AND the attack comes from within the frontal shield arc (~120°) */
  canBlockFrom(attackOrigin: Vector3): boolean {
    if (!this.isDefendingState) return false
    // Angle from player to attacker
    const dx = attackOrigin.x - this.position.x
    const dz = attackOrigin.z - this.position.z
    const angleToAttacker = Math.atan2(dx, dz)
    // Shield faces facingY - PI (facingY has +PI offset for model back-to-camera)
    let diff = angleToAttacker - this.facingY + Math.PI
    while (diff > Math.PI) diff -= Math.PI * 2
    while (diff < -Math.PI) diff += Math.PI * 2
    // Block if attacker is within ±60° of shield direction (120° frontal arc)
    return Math.abs(diff) < Math.PI / 3
  }

  getAttackAnim(): AnimState { return this.currentAnim }

  getSwordTip(): Vector3 {
    if (!this.swordRoot) return this.position.clone()
    return this.swordRoot.getAbsolutePosition()
  }

  takeDamage(amount: number) {
    if (this.dead || this.iframeTimer > 0) return
    this.health -= amount
    this.iframeTimer = 1.0
    this.damageFlashTimer = 0.5
    this.applyDamageFlash(true)
    if (this.health <= 0) {
      this.health = 0
      this.die()
    } else {
      this.playAnim('hit')
      this.attackLock = true
      this.attackLockTimer = 0.5
    }
  }

  knockBack(dir: Vector3, force: number) {
    this.velocity.x = dir.x * force
    this.velocity.z = dir.z * force
    this.velocity.y = force * 0.15
    this.knockbackTimer = 0.5
  }

  /** Push back from a blocked hit — no damage, stays in defend pose */
  shieldBounce(dir: Vector3, force: number) {
    this.velocity.x = dir.x * force
    this.velocity.z = dir.z * force
    this.velocity.y = force * 0.1
    this.knockbackTimer = 0.3
  }

  private applyDamageFlash(on: boolean) {
    const meshes = this.skinMeshSets[this.skinIndex]
    if (!meshes) return
    for (const m of meshes) {
      if (!m.material) continue
      const mat = m.material as any
      if (mat.emissiveColor !== undefined) {
        mat.emissiveColor = on ? new Color3(1, 0.15, 0.15) : new Color3(0, 0, 0)
      }
    }
  }

  private die() {
    this.dead = true
    this.respawnTimer = 2.0
    this.playAnim('death')
    this.velocity.set(0, 0, 0)
  }

  private respawn() {
    this.dead = false
    this.health = this.maxHealth
    // Find a dry spawn point
    this.position = this.findDrySpawn()
    this.velocity.set(0, 0, 0)
    this.onGround = true
    this.attackLock = false
    this.attackLockTimer = 0
    this.iframeTimer = 2.0
    this.playAnim('idle')
  }

  private findDrySpawn(): Vector3 {
    // Try origin first, then search outward
    for (let r = 0; r <= 80; r += 5) {
      for (let a = 0; a < 8; a++) {
        const angle = a * Math.PI / 4
        const x = Math.cos(angle) * r
        const z = Math.sin(angle) * r
        const y = this.getGroundY(x, z)
        if (y > WATER_Y + 0.3) {
          return new Vector3(x, y + 2, z)
        }
      }
    }
    return new Vector3(0, 5, 0)
  }

  getHealth(): number { return this.health }
  getMaxHealth(): number { return this.maxHealth }
  isDead(): boolean { return this.dead }

  isThrowing(): boolean { return this.thrownActive && this.thrownBounces < 2 }
  getThrownSwordPos(): Vector3 | null {
    if (!this.thrownActive || this.thrownBounces >= 2) return null
    return this.thrownPos.clone()
  }
}
