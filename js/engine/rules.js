// Data-driven battle rules. Gameplay code consumes this module instead of
// embedding custom type/status names throughout the renderer or engine.
export const STANDARD_TYPES = Object.freeze([
  "Normal","Fire","Water","Electric","Grass","Ice","Fighting","Poison","Ground",
  "Flying","Psychic","Bug","Rock","Ghost","Dragon","Dark","Steel","Fairy"
]);

export const STANDARD_STATUSES = Object.freeze([
  "Burn","Paralysis","Freeze","Poison","Bad Poison","Sleep"
]);

export const MOVE_TARGET_DEFAULT = "opponent";

export function moveTarget(move) {
  const target = String(move?.target || MOVE_TARGET_DEFAULT).toLowerCase();
  if (target === "self") return "self";
  if (["ally","ally-one","teammate"].includes(target)) return "ally";
  if (["any","all"].includes(target)) return "any";
  return "opponent";
}

export function isStatusMoveUsable(move, pokemon) {
  return !(pokemon?.volatile?.tauntTurns > 0 && move?.category === "status");
}

export function isPersistentStatus(status) {
  return STANDARD_STATUSES.includes(status);
}

export function isSameStatus(a, b) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}
