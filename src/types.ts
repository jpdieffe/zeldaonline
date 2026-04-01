/** Animation states synced over the network */
export type AnimState =
  | 'idle' | 'run' | 'walk' | 'jog'
  | 'jump_start' | 'jump_loop' | 'jump_land'
  | 'roll' | 'crouch_idle' | 'crouch_fwd'
  | 'swim_idle' | 'swim_fwd'
  | 'sword_idle' | 'sword_attack_a' | 'sword_attack_b' | 'sword_attack_c'
  | 'sword_dash' | 'melee_hook'
  | 'defend' | 'hit' | 'death'
  | 'backflip' | 'fighting_idle' | 'fighting_jab_l' | 'fighting_jab_r'

/** Player state synced over the network */
export interface PlayerState {
  x: number
  y: number
  z: number
  ry: number
  anim: AnimState
  sword: boolean
  shield?: boolean
  skin?: string
}

/** Network message envelope */
export interface EnemyNetState {
  x: number; z: number; ry: number
  anim: string; hp: number
}

export type NetMessage =
  | { type: 'state'; state: PlayerState }
  | { type: 'enemies'; enemies: EnemyNetState[] }
