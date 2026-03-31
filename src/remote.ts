import '@babylonjs/loaders/glTF'
import {
  Scene,
  Vector3,
  SceneLoader,
  TransformNode,
  AnimationGroup,
} from '@babylonjs/core'
import type { AnimState, PlayerState } from './types'

const MODEL_SCALE = 1.0
const LERP_SPEED  = 10

// Same mapping as player.ts
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

const ONE_SHOT: Set<AnimState> = new Set([
  'jump_start', 'jump_land', 'roll', 'backflip',
  'sword_attack_a', 'sword_attack_b', 'sword_attack_c',
  'sword_dash', 'melee_hook', 'hit', 'death',
  'fighting_jab_l', 'fighting_jab_r',
])

export class RemotePlayer {
  private scene: Scene
  private root: TransformNode | null = null
  private animGroups = new Map<AnimState, AnimationGroup>()
  private currentAnim: AnimState = 'idle'
  private loaded = false

  private targetPos = Vector3.Zero()
  private targetRotY = 0

  constructor(scene: Scene) {
    this.scene = scene
    this.load()
  }

  private async load() {
    const result = await SceneLoader.ImportMeshAsync('', './assets/player/', 'player.glb', this.scene)

    this.root = result.meshes[0] as unknown as TransformNode
    this.root.scaling.setAll(MODEL_SCALE)

    for (const [state, glbName] of Object.entries(ANIM_NAME_MAP) as [AnimState, string][]) {
      const group = result.animationGroups.find(g => g.name === glbName)
      if (group) {
        group.stop()
        group.loopAnimation = !ONE_SHOT.has(state)
        this.animGroups.set(state, group)
      }
    }

    this.loaded = true
    this.playAnim('idle')
  }

  private playAnim(a: AnimState) {
    if (a === this.currentAnim || !this.loaded) return
    const prev = this.animGroups.get(this.currentAnim)
    if (prev) prev.stop()
    const next = this.animGroups.get(a)
    if (next) {
      next.start(next.loopAnimation, 1.0, next.from, next.to, false)
    }
    this.currentAnim = a
  }

  applyState(state: PlayerState) {
    this.targetPos.set(state.x, state.y, state.z)
    this.targetRotY = state.ry
    this.playAnim(state.anim)
  }

  update(dt: number) {
    if (!this.root || !this.loaded) return

    // Lerp position
    const pos = this.root.position
    pos.x += (this.targetPos.x - pos.x) * Math.min(1, LERP_SPEED * dt)
    pos.y += (this.targetPos.y - pos.y) * Math.min(1, LERP_SPEED * dt)
    pos.z += (this.targetPos.z - pos.z) * Math.min(1, LERP_SPEED * dt)

    // Lerp rotation
    let dr = this.targetRotY - this.root.rotation.y
    // Normalize to [-PI, PI]
    while (dr > Math.PI)  dr -= Math.PI * 2
    while (dr < -Math.PI) dr += Math.PI * 2
    this.root.rotation.y += dr * Math.min(1, LERP_SPEED * dt)
  }

  dispose() {
    this.root?.dispose()
  }
}
