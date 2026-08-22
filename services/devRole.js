// Development-role classification for the IDP responsibility hierarchy.
//
// dev_role is a normalised bucket (Ed/RL/EL/ACM/CM) distinct from the free-text
// position_title synced from Employment Hero. We auto-SUGGEST a bucket from the title,
// but a CM confirms/overrides it (see the Admin > Roles & Rooms screens) — EH titles
// vary ("Early Childhood Educator", "Room Leader", "Educational Leader", "Assistant
// Centre Manager", "Centre Manager", "Chef", "Kitchen Hand"...) and won't all map.

const ROLES = [
  { key: "ed", label: "Educator" },
  { key: "rl", label: "Room Leader" },
  { key: "el", label: "Educational Leader" },
  { key: "acm", label: "Assistant Centre Manager" },
  { key: "cm", label: "Centre Manager" },
];

const ROLE_LABEL = Object.fromEntries(ROLES.map((r) => [r.key, r.label]));

// Order matters: more specific titles are tested before broader ones (e.g. "Assistant
// Centre Manager" must beat "Centre Manager", "Educational Leader" must beat "Educator").
const SUGGEST_RULES = [
  { match: /assistant\s+(centre|center)\s+manager|assistant\s+director|^acm\b/i, role: "acm" },
  { match: /(centre|center)\s+manager|^cm\b|director/i, role: "cm" },
  { match: /educational\s+leader|ed\.?\s*leader|^el\b/i, role: "el" },
  { match: /room\s+leader|team\s+leader|^rl\b/i, role: "rl" },
  { match: /educator|teacher|trainee/i, role: "ed" },
];

// Returns a suggested dev_role key, or null when the title doesn't clearly map (e.g.
// Chef, Kitchen Hand, Cleaner, Administration) — the CM decides those explicitly.
function suggestDevRole(positionTitle) {
  if (!positionTitle) return null;
  const hit = SUGGEST_RULES.find((r) => r.match.test(positionTitle));
  return hit ? hit.role : null;
}

function isValidDevRole(role) {
  return ROLES.some((r) => r.key === role);
}

module.exports = { ROLES, ROLE_LABEL, suggestDevRole, isValidDevRole };
