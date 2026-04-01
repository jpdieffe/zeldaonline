import '@babylonjs/loaders/glTF'
import {
  Scene,
  Vector3,
  SceneLoader,
  TransformNode,
  AnimationGroup,
  AbstractMesh,
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

const SKIN_NAMES = ['player', 'link']

export class RemotePlayer {
  private scene: Scene
  private root: TransformNode | null = null
  private animGroups = new Map<AnimState, AnimationGroup>()
  private currentAnim: AnimState = 'idle'
  private currentSkin = 'player'

  private skinRoots: TransformNode[] = []
  private skinMeshSets: AbstractMesh[][] = []
  private skinAnimSets: Map<AnimState, AnimationGroup>[] = []
  private loaded = false

  private targetPos = Vector3.Zero()
  private targetRotY = 0
  private swordMeshes: AbstractMesh[] = []
  private swordEquipped = false

  constructor(scene: Scene) {
    this.scene = scene
    this.load()
  }

  private swordPivot: TransformNode | null = null

  private async load() {
    // Create a root pivot for position/rotation
    this.root = new TransformNode('remotePivot', this.scene)

    // Load all skins
    for (const skinName of SKIN_NAMES) {
      const result = await SceneLoader.ImportMeshAsync('', './assets/player/', `${skinName}.glb`, this.scene)
      const skinRoot = result.meshes[0] as unknown as TransformNode
      skinRoot.parent = this.root
      skinRoot.scaling.setAll(MODEL_SCALE)
      this.skinRoots.push(skinRoot)
      this.skinMeshSets.push(result.meshes.slice(1) as AbstractMesh[])

      const anims = new Map<AnimState, AnimationGroup>()
      for (const [state, glbName] of Object.entries(ANIM_NAME_MAP) as [AnimState, string][]) {
        const group = result.animationGroups.find(g => g.name === glbName)
        if (group) {
          group.stop()
          group.loopAnimation = !ONE_SHOT.has(state)
          anims.set(state, group)
        }
      }
      this.skinAnimSets.push(anims)
    }

    // Activate default skin, hide others
    this.switchSkin('player')
    this.loaded = true
    this.playAnim('idle')

    // Load sword for remote player
    const handBone = this.skinRoots[0].getChildTransformNodes(false)
      .find(n => n.name === 'hand_r')
    if (handBone) {
      const swordResult = await SceneLoader.ImportMeshAsync('', './assets/weapons/', 'sword.glb', this.scene)
      this.swordPivot = new TransformNode('swordPivotRemote', this.scene)
      this.swordPivot.parent = handBone
      this.swordPivot.position.set(0, 0.35, 0.25)
      this.swordPivot.rotation.set(2.3, 0, 0)
      const swordRoot = swordResult.meshes[0] as unknown as TransformNode
      swordRoot.parent = this.swordPivot
      this.swordMeshes = swordResult.meshes.filter(m => m !== swordResult.meshes[0])
      for (const m of this.swordMeshes) m.isVisible = false
    }
  }

  private switchSkin(name: string) {
    const idx = SKIN_NAMES.indexOf(name)
    if (idx < 0) return

    // Stop current anims
    for (const ag of this.animGroups.values()) ag.stop()

    // Hide all skins
    for (const meshes of this.skinMeshSets) {
      for (const m of meshes) m.isVisible = false
    }

    // Show target skin
    for (const m of this.skinMeshSets[idx]) m.isVisible = true
    this.animGroups = this.skinAnimSets[idx]
    this.currentSkin = name

    // Re-attach sword
    if (this.swordPivot) {
      const handBone = this.skinRoots[idx].getChildTransformNodes(false)
        .find(n => n.name === 'hand_r')
      if (handBone) this.swordPivot.parent = handBone
    }

    // Restart current anim
    const cur = this.currentAnim
    this.currentAnim = 'idle'
    this.playAnim(cur)
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
    if (state.sword !== this.swordEquipped) {
      this.swordEquipped = state.sword
      for (const m of this.swordMeshes) m.isVisible = state.sword
    }
    if (state.skin && state.skin !== this.currentSkin) {
      this.switchSkin(state.skin)
    }
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
