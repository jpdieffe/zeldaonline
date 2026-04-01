import '@babylonjs/loaders/glTF'
import {
  Scene,
  Vector3,
  ArcRotateCamera,
  SceneLoader,
  TransformNode,
  AnimationGroup,
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
const GROUND_Y      = 0       // flat ground plane
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
  private modelRoot: TransformNode | null = null
  private animGroups = new Map<AnimState, AnimationGroup>()
  private animDurations = new Map<AnimState, number>()
  private currentAnim: AnimState = 'idle'
  private animsLoaded = false

  // Combat
  private swordComboIndex = 0               // 0-2 cycles through A, B, C
  private comboTimer = 0                    // time left to chain next combo
  private attackLock = false                // true while playing attack anim
  private attackLockTimer = 0
  private isDefending = false

  // Jump state machine
  private jumpPhase: 'none' | 'start' | 'loop' | 'land' = 'none'
  private jumpPhaseTimer = 0

  // Swimming
  private swimming = false

  // Sprint
  private sprinting = false

  constructor(scene: Scene) {
    this.scene = scene
    this.setupCamera()
    this.setupInput()
    this.loadModel()
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
    const result = await SceneLoader.ImportMeshAsync('', './assets/player/', 'player.glb', this.scene)

    this.modelRoot = result.meshes[0] as unknown as TransformNode
    this.modelRoot.scaling.setAll(MODEL_SCALE)

    // Map animation groups by our AnimState key
    for (const [state, glbName] of Object.entries(ANIM_NAME_MAP) as [AnimState, string][]) {
      const group = result.animationGroups.find(g => g.name === glbName)
      if (group) {
        group.stop()
        group.loopAnimation = !ONE_SHOT.has(state)
        this.animGroups.set(state, group)
        // Store actual duration so attack lock timers match animation length
        const fps = group.targetedAnimations[0]?.animation.framePerSecond ?? 30
        this.animDurations.set(state, (group.to - group.from) / fps)
      } else {
        console.warn(`Animation not found: ${glbName}`)
      }
    }

    this.animsLoaded = true
    this.playAnim('idle')
  }

  private playAnim(a: AnimState) {
    if (a === this.currentAnim || !this.animsLoaded) return
    const prev = this.animGroups.get(this.currentAnim)
    if (prev) prev.stop()
    const next = this.animGroups.get(a)
    if (next) {
      next.start(next.loopAnimation, 1.0, next.from, next.to, false)
    }
    this.currentAnim = a
  }

  // ── Update ────────────────────────────────────────────────────────────────
  update(dt: number) {
    this.updateTimers(dt)

    // ── Attack input ──────────────────────────────────────────────────────
    if (this.mouseLeft && !this.attackLock && this.onGround && !this.swimming) {
      this.startAttack()
    }

    // ── Defend ────────────────────────────────────────────────────────────
    this.isDefending = this.mouseRight && this.onGround && !this.attackLock && !this.swimming

    // ── Roll / backflip ───────────────────────────────────────────────────
    if (this.keys.has('q') && this.onGround && !this.attackLock && !this.swimming) {
      this.keys.delete('q')
      this.attackLock = true
      this.attackLockTimer = this.animDurations.get('roll') ?? 0.8
      this.playAnim('roll')
    }

    // ── Horizontal movement ───────────────────────────────────────────────
    let moveX = 0, moveZ = 0
    if (this.keys.has('w') || this.keys.has('arrowup'))    moveZ += 1
    if (this.keys.has('s') || this.keys.has('arrowdown'))  moveZ -= 1
    if (this.keys.has('a') || this.keys.has('arrowleft'))  moveX -= 1
    if (this.keys.has('d') || this.keys.has('arrowright')) moveX += 1

    // Derive forward from camera alpha so mouse steering is always accurate
    // ArcRotateCamera offset = (R*sinβ*sinα, R*cosβ, R*sinβ*cosα)
    // so look direction in XZ = (-sinα, 0, -cosα)
    const alpha = this.camera.alpha
    const forward = new Vector3(-Math.sin(alpha), 0, -Math.cos(alpha)).normalize()
    const right   = new Vector3(forward.z, 0, -forward.x)

    const moveDir = forward.scale(moveZ).add(right.scale(moveX))
    const moving  = moveDir.length() > 0.01
    if (moving) moveDir.normalize()

    // Player always faces camera direction; when moving, face movement direction instead
    if (!this.attackLock) {
      if (moving) {
        this.facingY = Math.atan2(moveDir.x, moveDir.z)
      } else {
        this.facingY = Math.atan2(forward.x, forward.z)
      }
    }

    // Speed selection
    let speed = WALK_SPEED
    if (this.sprinting)  speed = RUN_SPEED
    else if (moving)     speed = JOG_SPEED
    if (this.attackLock || this.isDefending) speed = 0
    if (this.swimming) speed = this.sprinting ? JOG_SPEED : WALK_SPEED

    this.velocity.x = moveDir.x * speed
    this.velocity.z = moveDir.z * speed

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

    // Land on ground
    if (this.position.y <= GROUND_Y && this.velocity.y <= 0) {
      this.position.y = GROUND_Y
      this.velocity.y = 0
      if (!this.onGround) {
        this.onGround = true
        this.jumpPhase = 'land'
        this.jumpPhaseTimer = 0.2
        this.playAnim('jump_land')
      }
    }

    // ── Swimming detection ────────────────────────────────────────────────
    this.swimming = this.position.y <= WATER_Y

    // ── Animation state machine ───────────────────────────────────────────
    this.updateAnimation(moving)

    // ── Sync model ────────────────────────────────────────────────────────
    if (this.modelRoot) {
      this.modelRoot.position.copyFrom(this.position)
      this.modelRoot.rotation.y = this.facingY
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
        this.attackLockTimer = 0
      }
    }
    if (this.comboTimer > 0) {
      this.comboTimer -= dt
      if (this.comboTimer <= 0) {
        this.swordComboIndex = 0
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
    const duration = this.animDurations.get(anim) ?? 0.7
    this.attackLock = true
    this.attackLockTimer = duration
    this.comboTimer = duration + 0.5
    this.swordComboIndex = (this.swordComboIndex + 1) % 3
    this.playAnim(anim)
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
    if (this.isDefending) { this.playAnim('defend'); return }

    // Ground movement
    if (moving) {
      if (this.sprinting) this.playAnim('run')
      else                this.playAnim('jog')
    } else {
      this.playAnim('idle')
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────
  getState(): PlayerState {
    return {
      x: this.position.x,
      y: this.position.y,
      z: this.position.z,
      ry: this.facingY,
      anim: this.currentAnim,
    }
  }

  getPosition(): Vector3 { return this.position.clone() }
}
