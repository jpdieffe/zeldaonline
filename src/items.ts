// ── Item Definitions ─────────────────────────────────────────────────────────

export type ItemCategory = 'food' | 'potion' | 'scroll'
export type ScrollMode = 'instant' | 'target'
export type SpellElement = 'fire' | 'water' | 'rock' | 'lightning' | 'grass' | 'laser'
export type InstantEffect = 'armor' | 'summon' | 'fly' | 'invisibility'

export interface ItemDef {
  id: string
  name: string
  emoji: string
  category: ItemCategory
  description: string
  // Food / potion
  healAmount?: number
  // Scroll
  scrollMode?: ScrollMode
  instantEffect?: InstantEffect
  spellElement?: SpellElement
  duration?: number        // seconds for buffs
  spellDamage?: number     // damage for target spells
}

// ── Food Items ───────────────────────────────────────────────────────────────
const FOODS: ItemDef[] = [
  { id: 'apple',       name: 'Apple',        emoji: '🍎', category: 'food', healAmount: 1, description: 'Restores 1 ❤️' },
  { id: 'pear',        name: 'Pear',         emoji: '🍐', category: 'food', healAmount: 1, description: 'Restores 1 ❤️' },
  { id: 'cherry',      name: 'Cherries',     emoji: '🍒', category: 'food', healAmount: 1, description: 'Restores 1 ❤️' },
  { id: 'banana',      name: 'Banana',       emoji: '🍌', category: 'food', healAmount: 2, description: 'Restores 2 ❤️' },
  { id: 'grapes',      name: 'Grapes',       emoji: '🍇', category: 'food', healAmount: 2, description: 'Restores 2 ❤️' },
  { id: 'watermelon',  name: 'Watermelon',   emoji: '🍉', category: 'food', healAmount: 3, description: 'Restores 3 ❤️' },
  { id: 'meat',        name: 'Meat',         emoji: '🍖', category: 'food', healAmount: 3, description: 'Restores 3 ❤️' },
  { id: 'pizza',       name: 'Pizza',        emoji: '🍕', category: 'food', healAmount: 4, description: 'Restores 4 ❤️' },
  { id: 'cake',        name: 'Cake',         emoji: '🎂', category: 'food', healAmount: 5, description: 'Restores 5 ❤️' },
  { id: 'golden_apple',name: 'Golden Apple',  emoji: '🌟', category: 'food', healAmount: 6, description: 'Full heal! Restores 6 ❤️' },
]

// ── Potions ──────────────────────────────────────────────────────────────────
const POTIONS: ItemDef[] = [
  { id: 'potion_s', name: 'Small Potion',  emoji: '🧪', category: 'potion', healAmount: 2, description: 'Restores 2 ❤️' },
  { id: 'potion_m', name: 'Medium Potion', emoji: '⚗️', category: 'potion', healAmount: 4, description: 'Restores 4 ❤️' },
  { id: 'potion_l', name: 'Large Potion',  emoji: '🏺', category: 'potion', healAmount: 6, description: 'Full heal! Restores 6 ❤️' },
]

// ── Scrolls: Instant ─────────────────────────────────────────────────────────
const INSTANT_SCROLLS: ItemDef[] = [
  { id: 'scroll_armor',   name: 'Armor Scroll',       emoji: '🛡️', category: 'scroll', scrollMode: 'instant', instantEffect: 'armor',        duration: 15, description: 'Armor buff for 15s — take half damage' },
  { id: 'scroll_summon',  name: 'Summon Scroll',      emoji: '👻', category: 'scroll', scrollMode: 'instant', instantEffect: 'summon',       duration: 20, description: 'Summon a friendly minion for 20s' },
  { id: 'scroll_fly',     name: 'Flight Scroll',      emoji: '🕊️', category: 'scroll', scrollMode: 'instant', instantEffect: 'fly',          duration: 10, description: 'Fly for 10s — press space to ascend' },
  { id: 'scroll_invis',   name: 'Invisibility Scroll',emoji: '👁️', category: 'scroll', scrollMode: 'instant', instantEffect: 'invisibility', duration: 12, description: 'Invisible for 12s — enemies ignore you' },
]

// ── Scrolls: Target ──────────────────────────────────────────────────────────
const TARGET_SCROLLS: ItemDef[] = [
  { id: 'scroll_fire',      name: 'Fire Scroll',      emoji: '🔥', category: 'scroll', scrollMode: 'target', spellElement: 'fire',      spellDamage: 5, description: 'Aim & fire a fireball — 5 damage' },
  { id: 'scroll_water',     name: 'Water Scroll',     emoji: '🌊', category: 'scroll', scrollMode: 'target', spellElement: 'water',     spellDamage: 3, description: 'Aim & fire a water blast — 3 damage + knockback' },
  { id: 'scroll_rock',      name: 'Rock Scroll',      emoji: '🪨', category: 'scroll', scrollMode: 'target', spellElement: 'rock',      spellDamage: 4, description: 'Aim & hurl a boulder — 4 damage' },
  { id: 'scroll_lightning', name: 'Lightning Scroll', emoji: '⚡', category: 'scroll', scrollMode: 'target', spellElement: 'lightning', spellDamage: 6, description: 'Aim & call lightning — 6 damage' },
  { id: 'scroll_grass',     name: 'Grass Scroll',     emoji: '🌿', category: 'scroll', scrollMode: 'target', spellElement: 'grass',     spellDamage: 3, description: 'Aim & launch thorns — 3 damage + slow' },
  { id: 'scroll_laser',     name: 'Laser Scroll',     emoji: '💥', category: 'scroll', scrollMode: 'target', spellElement: 'laser',     spellDamage: 8, description: 'Aim & fire a laser beam — 8 damage' },
]

// ── All Items + Lookup ───────────────────────────────────────────────────────
export const ALL_ITEMS: ItemDef[] = [...FOODS, ...POTIONS, ...INSTANT_SCROLLS, ...TARGET_SCROLLS]
export const ITEM_MAP = new Map<string, ItemDef>(ALL_ITEMS.map(i => [i.id, i]))

export function getItem(id: string): ItemDef | undefined {
  return ITEM_MAP.get(id)
}

// ── Loot Table (weighted) ────────────────────────────────────────────────────
interface LootEntry { id: string; weight: number }

const LOOT_TABLE: LootEntry[] = [
  // Common food (weight 10 each)
  { id: 'apple', weight: 10 }, { id: 'pear', weight: 10 }, { id: 'cherry', weight: 10 },
  { id: 'banana', weight: 8 }, { id: 'grapes', weight: 8 },
  // Uncommon food
  { id: 'watermelon', weight: 5 }, { id: 'meat', weight: 5 },
  { id: 'pizza', weight: 3 }, { id: 'cake', weight: 2 },
  { id: 'golden_apple', weight: 1 },
  // Potions
  { id: 'potion_s', weight: 8 }, { id: 'potion_m', weight: 4 }, { id: 'potion_l', weight: 1 },
  // Scrolls — rarer
  { id: 'scroll_fire', weight: 2 }, { id: 'scroll_water', weight: 2 },
  { id: 'scroll_rock', weight: 2 }, { id: 'scroll_lightning', weight: 1 },
  { id: 'scroll_grass', weight: 2 }, { id: 'scroll_laser', weight: 1 },
  { id: 'scroll_armor', weight: 2 }, { id: 'scroll_summon', weight: 1 },
  { id: 'scroll_fly', weight: 1 }, { id: 'scroll_invis', weight: 1 },
]

const TOTAL_WEIGHT = LOOT_TABLE.reduce((s, e) => s + e.weight, 0)

/** Roll a random loot drop. Returns null ~40% of the time (no drop). */
export function rollLoot(): string | null {
  if (Math.random() < 0.4) return null  // 40% chance no drop
  let r = Math.random() * TOTAL_WEIGHT
  for (const entry of LOOT_TABLE) {
    r -= entry.weight
    if (r <= 0) return entry.id
  }
  return LOOT_TABLE[0].id
}
