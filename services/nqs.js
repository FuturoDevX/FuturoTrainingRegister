// National Quality Standard (NQS) reference data — Quality Areas, Standards, and Elements,
// per ACECQA (Australian Children's Education & Care Quality Authority).
//
// 7 Quality Areas, 15 Standards, 40 Elements. Cross-checked against ACECQA's published
// element titles and the 1 January 2026 NQF child safety change, which renamed Element
// 2.2.3 from "Child protection" to "Child safety and protection" and added an explicit
// child-safe-by-design expectation to Quality Area 7 governance (guidance-level, no
// element renumbering) — see acecqa.gov.au/nqf-child-safety-changes-1-september-2025-and-1-january-2026.
// This is reference/config data, not something Admin edits in-app — update here if
// ACECQA revises the standard again.

const QUALITY_AREAS = [
  {
    number: 1,
    name: "Educational program and practice",
    standards: [
      {
        number: "1.1",
        name: "Program",
        elements: [
          { code: "1.1.1", name: "Approved learning framework" },
          { code: "1.1.2", name: "Child-centred" },
          { code: "1.1.3", name: "Program learning opportunities" },
        ],
      },
      {
        number: "1.2",
        name: "Practice",
        elements: [
          { code: "1.2.1", name: "Intentional teaching" },
          { code: "1.2.2", name: "Responsive teaching and scaffolding" },
          { code: "1.2.3", name: "Child directed learning" },
        ],
      },
      {
        number: "1.3",
        name: "Assessment and planning",
        elements: [
          { code: "1.3.1", name: "Assessment and planning cycle" },
          { code: "1.3.2", name: "Critical reflection" },
          { code: "1.3.3", name: "Information for families" },
        ],
      },
    ],
  },
  {
    number: 2,
    name: "Children's health and safety",
    standards: [
      {
        number: "2.1",
        name: "Health",
        elements: [
          { code: "2.1.1", name: "Wellbeing and comfort" },
          { code: "2.1.2", name: "Health practices and procedures" },
          { code: "2.1.3", name: "Healthy lifestyle" },
        ],
      },
      {
        number: "2.2",
        name: "Safety",
        elements: [
          { code: "2.2.1", name: "Supervision" },
          { code: "2.2.2", name: "Incident and emergency management" },
          { code: "2.2.3", name: "Child safety and protection" },
        ],
      },
    ],
  },
  {
    number: 3,
    name: "Physical environment",
    standards: [
      {
        number: "3.1",
        name: "Design",
        elements: [
          { code: "3.1.1", name: "Fit for purpose" },
          { code: "3.1.2", name: "Upkeep" },
        ],
      },
      {
        number: "3.2",
        name: "Use",
        elements: [
          { code: "3.2.1", name: "Inclusive environment" },
          { code: "3.2.2", name: "Resources support play-based learning" },
          { code: "3.2.3", name: "Environmentally responsible" },
        ],
      },
    ],
  },
  {
    number: 4,
    name: "Staffing arrangements",
    standards: [
      {
        number: "4.1",
        name: "Staffing arrangements",
        elements: [
          { code: "4.1.1", name: "Organisation of educators" },
          { code: "4.1.2", name: "Continuity of staff" },
        ],
      },
      {
        number: "4.2",
        name: "Professionalism",
        elements: [
          { code: "4.2.1", name: "Professional collaboration" },
          { code: "4.2.2", name: "Professional standards" },
        ],
      },
    ],
  },
  {
    number: 5,
    name: "Relationships with children",
    standards: [
      {
        number: "5.1",
        name: "Relationships between educators and children",
        elements: [
          { code: "5.1.1", name: "Positive educator to child interactions" },
          { code: "5.1.2", name: "Dignity and rights of the child" },
        ],
      },
      {
        number: "5.2",
        name: "Relationships between children",
        elements: [
          { code: "5.2.1", name: "Collaborative learning" },
          { code: "5.2.2", name: "Self-regulation" },
        ],
      },
    ],
  },
  {
    number: 6,
    name: "Collaborative partnerships with families and communities",
    standards: [
      {
        number: "6.1",
        name: "Supportive relationships with families",
        elements: [
          { code: "6.1.1", name: "Engagement with the service" },
          { code: "6.1.2", name: "Parent views are respected" },
          { code: "6.1.3", name: "Families are supported" },
        ],
      },
      {
        number: "6.2",
        name: "Collaborative partnerships",
        elements: [
          { code: "6.2.1", name: "Transitions" },
          { code: "6.2.2", name: "Access and participation" },
          { code: "6.2.3", name: "Community engagement" },
        ],
      },
    ],
  },
  {
    number: 7,
    name: "Governance and leadership",
    standards: [
      {
        number: "7.1",
        name: "Governance",
        elements: [
          { code: "7.1.1", name: "Service philosophy and purpose" },
          { code: "7.1.2", name: "Management systems" },
          { code: "7.1.3", name: "Roles and responsibilities" },
        ],
      },
      {
        number: "7.2",
        name: "Leadership",
        elements: [
          { code: "7.2.1", name: "Continuous improvement" },
          { code: "7.2.2", name: "Educational leadership" },
          { code: "7.2.3", name: "Development of professionals" },
        ],
      },
    ],
  },
];

// Flat code -> element lookup (includes the quality area number for tag display).
const ELEMENTS_BY_CODE = new Map();
for (const area of QUALITY_AREAS) {
  for (const standard of area.standards) {
    for (const element of standard.elements) {
      ELEMENTS_BY_CODE.set(element.code, { ...element, qualityArea: area.number });
    }
  }
}

function isValidElementCode(code) {
  return ELEMENTS_BY_CODE.has(code);
}

function elementLabel(code) {
  const el = ELEMENTS_BY_CODE.get(code);
  return el ? `${el.code} ${el.name}` : code;
}

module.exports = { QUALITY_AREAS, ELEMENTS_BY_CODE, isValidElementCode, elementLabel };
