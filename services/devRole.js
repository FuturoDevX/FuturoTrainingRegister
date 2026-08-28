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
  // Support/non-contact staff (chef, kitchen, cleaning, admin, maintenance) who aren't on
  // the educator development track — marking them here keeps them out of IDP coverage and
  // the "no IDP" nudges, rather than counting against a centre or sitting unclassified.
  { key: "non_contact", label: "Non-contact / support" },
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
  { match: /chef|cook|kitchen|cleaner|cleaning|admin|reception|maintenance|gardener|driver|laundry|handyman|hand\b/i, role: "non_contact" },
];

// Returns a suggested dev_role key, or null when the title doesn't clearly map — the CM
// decides those explicitly. Non-contact titles (Chef, Kitchen Hand, Cleaner, Admin…) now
// suggest 'non_contact' rather than falling through to null.
function suggestDevRole(positionTitle) {
  if (!positionTitle) return null;
  const hit = SUGGEST_RULES.find((r) => r.match.test(positionTitle));
  return hit ? hit.role : null;
}

function isValidDevRole(role) {
  return ROLES.some((r) => r.key === role);
}

module.exports = { ROLES, ROLE_LABEL, suggestDevRole, isValidDevRole };
