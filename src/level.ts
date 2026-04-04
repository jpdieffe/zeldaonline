/**
 * Level data loader — reads JSON produced by the Python level builder.
 */

export interface LevelData {
  version: number
  groundSize: number
  subdivisions: number
  waterY: number
  heightmap: number[][]          // [gz][gx] array of heights
  objects: LevelObject[]
  roads: [number, number][][]    // array of polylines, each point is [wx, wz]
}

export interface LevelObject {
  type: string   // player_spawn | enemy_orc | enemy_goblin | cabin | tower | campfire
  wx: number
  wz: number
}

/**
 * Try to fetch level.json from the server.
 * Returns null if not found or on error (falls back to procedural).
 */
export async function loadLevelData(): Promise<LevelData | null> {
  try {
    const resp = await fetch('./level.json')
    if (!resp.ok) return null
    const data = await resp.json() as LevelData
    if (!data.heightmap || !Array.isArray(data.heightmap)) return null
    return data
  } catch {
    return null
  }
}
