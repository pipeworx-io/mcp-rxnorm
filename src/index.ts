interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * RxNorm MCP — wraps the NLM RxNav REST API (free, no auth)
 *
 * RxNorm is the standard drug nomenclature system that normalizes drug names
 * across brands, generics, and ingredients.
 *
 * Tools:
 * - rxnorm_search: search for drugs by name (brand or generic)
 * - rxnorm_get_properties: get properties for a drug by RxCUI
 * - rxnorm_related: get related concepts (brand <-> generic <-> ingredient <-> dose forms)
 * - rxnorm_interactions: check drug-drug interactions
 * - rxnorm_ndc: get NDC codes for a drug
 */


const BASE_URL = 'https://rxnav.nlm.nih.gov/REST';

const tools: McpToolExport['tools'] = [
  {
    name: 'rxnorm_search',
    description:
      'Search for drugs by name (brand or generic). Returns concept groups with RxCUI identifiers, names, synonyms, and term types (BN=brand, IN=ingredient, SBD=branded dose form, etc.).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Drug name to search for — brand or generic (e.g., "Ozempic", "semaglutide", "metformin")',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'rxnorm_get_properties',
    description:
      'Get properties for a drug by its RxCUI (RxNorm concept ID). Returns name, synonym, term type, language, and suppress flag.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        rxcui: { type: 'string', description: 'RxNorm concept ID (e.g., "7052" for metformin)' },
      },
      required: ['rxcui'],
    },
  },
  {
    name: 'rxnorm_related',
    description:
      'Get related concepts for a drug — brand names, generics, ingredients, and dose forms. Useful for mapping between brand and generic names.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        rxcui: { type: 'string', description: 'RxNorm concept ID' },
        tty: {
          type: 'string',
          description:
            'Optional term type filter: BN (brand name), IN (ingredient), SBD (semantic branded drug), SCD (semantic clinical drug), GPCK (generic pack), BPCK (branded pack). Comma-separated for multiple.',
        },
      },
      required: ['rxcui'],
    },
  },
  {
    name: 'rxnorm_interactions',
    description:
      'Check drug-drug interactions for a given RxCUI. NOTE: The NIH retired this API in January 2024 — this tool may return errors. Use PubMed or drug label lookups for interaction data instead.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        rxcui: { type: 'string', description: 'RxNorm concept ID of the drug to check interactions for' },
        sources: {
          type: 'string',
          description: 'Optional interaction source filter: "DrugBank", "ONCHigh", or omit for all sources',
        },
      },
      required: ['rxcui'],
    },
  },
  {
    name: 'rxnorm_ndc',
    description:
      'Get NDC (National Drug Code) identifiers for a drug by its RxCUI. NDC codes uniquely identify drug products in the US market.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        rxcui: { type: 'string', description: 'RxNorm concept ID' },
      },
      required: ['rxcui'],
    },
  },
];

// ── Response types ──────────────────────────────────────────────────

interface DrugConcept {
  rxcui: string;
  name: string;
  synonym: string;
  tty: string;
  language: string;
  suppress: string;
  umlscui: string;
}

interface ConceptGroup {
  tty: string;
  conceptProperties?: DrugConcept[];
}

interface DrugGroup {
  name: string;
  conceptGroup?: ConceptGroup[];
}

interface PropertiesConcept {
  rxcui: string;
  name: string;
  synonym: string;
  tty: string;
  language: string;
  suppress: string;
  umlscui: string;
}

interface RelatedGroup {
  conceptGroup?: ConceptGroup[];
}

interface InteractionConcept {
  minConceptItem: {
    rxcui: string;
    name: string;
    tty: string;
  };
  sourceConceptItem: {
    id: string;
    name: string;
    url: string;
  };
}

interface InteractionPair {
  interactionConcept: InteractionConcept[];
  severity: string;
  description: string;
}

interface InteractionTypeGroup {
  sourceDisclaimer: string;
  sourceName: string;
  fullInteractionType?: {
    comment: string;
    minConcept: { rxcui: string; name: string; tty: string }[];
    interactionPair: InteractionPair[];
  }[];
}

// ── Tool implementations ────────────────────────────────────────────

async function searchDrugs(name: string) {
  const res = await fetch(`${BASE_URL}/drugs.json?name=${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`RxNorm API error: ${res.status}`);

  const data = (await res.json()) as { drugGroup: DrugGroup };
  const drugGroup = data.drugGroup;
  if (!drugGroup?.conceptGroup) {
    return { name: drugGroup?.name ?? name, concept_groups: [] };
  }

  return {
    name: drugGroup.name,
    concept_groups: drugGroup.conceptGroup
      .filter((g) => g.conceptProperties && g.conceptProperties.length > 0)
      .map((g) => ({
        term_type: g.tty,
        concepts: g.conceptProperties!.map((c) => ({
          rxcui: c.rxcui,
          name: c.name,
          synonym: c.synonym || null,
          tty: c.tty,
          language: c.language,
        })),
      })),
  };
}

async function getProperties(rxcui: string) {
  const res = await fetch(`${BASE_URL}/rxcui/${encodeURIComponent(rxcui)}/properties.json`);
  if (!res.ok) throw new Error(`RxNorm API error: ${res.status}`);

  const data = (await res.json()) as { properties: PropertiesConcept | null };
  if (!data.properties) throw new Error(`No properties found for RxCUI: ${rxcui}`);

  const p = data.properties;
  return {
    rxcui: p.rxcui,
    name: p.name,
    synonym: p.synonym || null,
    tty: p.tty,
    language: p.language,
    suppress: p.suppress,
  };
}

async function getRelated(rxcui: string, tty?: string) {
  const ttyParam = tty || 'IN+BN+SBD+SCD+GPCK+BPCK';
  let url = `${BASE_URL}/rxcui/${encodeURIComponent(rxcui)}/related.json?tty=${encodeURIComponent(ttyParam)}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`RxNorm API error: ${res.status}`);

  const data = (await res.json()) as { relatedGroup: RelatedGroup };
  const groups = data.relatedGroup?.conceptGroup;
  if (!groups) return { rxcui, related_groups: [] };

  return {
    rxcui,
    related_groups: groups
      .filter((g) => g.conceptProperties && g.conceptProperties.length > 0)
      .map((g) => ({
        term_type: g.tty,
        concepts: g.conceptProperties!.map((c) => ({
          rxcui: c.rxcui,
          name: c.name,
          tty: c.tty,
        })),
      })),
  };
}

async function getInteractions(rxcui: string, sources?: string) {
  let url = `${BASE_URL}/interaction/interaction.json?rxcui=${encodeURIComponent(rxcui)}`;
  if (sources) url += `&sources=${encodeURIComponent(sources)}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`RxNorm API error: ${res.status}`);

  const data = (await res.json()) as {
    interactionTypeGroup?: InteractionTypeGroup[];
  };

  if (!data.interactionTypeGroup) {
    return { rxcui, interactions: [] };
  }

  return {
    rxcui,
    interactions: data.interactionTypeGroup.map((group) => ({
      source: group.sourceName,
      disclaimer: group.sourceDisclaimer,
      pairs: (group.fullInteractionType ?? []).flatMap((fit) =>
        fit.interactionPair.map((pair) => ({
          drugs: fit.minConcept.map((c) => ({ rxcui: c.rxcui, name: c.name })),
          severity: pair.severity,
          description: pair.description,
        })),
      ),
    })),
  };
}

async function getNdcCodes(rxcui: string) {
  const res = await fetch(`${BASE_URL}/rxcui/${encodeURIComponent(rxcui)}/ndcs.json`);
  if (!res.ok) throw new Error(`RxNorm API error: ${res.status}`);

  const data = (await res.json()) as { ndcGroup: { ndcList?: { ndc: string[] } } };
  const ndcs = data.ndcGroup?.ndcList?.ndc ?? [];

  return {
    rxcui,
    ndc_count: ndcs.length,
    ndcs,
  };
}

// ── callTool dispatcher ─────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'rxnorm_search':
      return searchDrugs(args.name as string);

    case 'rxnorm_get_properties':
      return getProperties(args.rxcui as string);

    case 'rxnorm_related':
      return getRelated(args.rxcui as string, args.tty as string | undefined);

    case 'rxnorm_interactions':
      return getInteractions(args.rxcui as string, args.sources as string | undefined);

    case 'rxnorm_ndc':
      return getNdcCodes(args.rxcui as string);

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 5 } } satisfies McpToolExport;
