# RxNorm — Standardized Drug Concepts

The National Library of Medicine's standardized drug nomenclature. Every prescription, OTC drug, and ingredient in the US healthcare system has an RxCUI (a stable concept ID). RxNorm normalizes drug naming chaos: "Tylenol" and "acetaminophen" and "APAP" all resolve to the same ingredient concept. Free, no auth.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

## Why this matters for AI agents

Drug data is notoriously messy. Brand names, generic names, salt forms, dose strengths, dosage forms — same molecule, dozens of strings. RxNorm gives you canonical IDs you can use to cross-reference FDA data, drug interaction databases, EHR systems, and clinical trials.

Three core flows:

**1. Resolve a name.** "What's Ozempic?" → `rxnorm_search({name: "ozempic"})` → concept groups by term type (SBD, BN, IN, etc.) with RxCUIs.

**2. Get drug properties.** "What's this RxCUI?" → `rxnorm_get_properties({rxcui})` → ingredient name, strength, dose form, brand status.

**3. Drug interactions.** "What does this interact with?" → `rxnorm_interactions({rxcui})` → known drug-drug interactions with severity.

For full drug-safety synthesis combining RxNorm + FDA + ClinicalTrials, use [`compare_entities({type: "drug", values})`] or the `pharma_drug_profile` compound.

## Term types (TTYs) — important to understand

RxNorm has multiple concepts per drug, each at different abstraction levels:

| TTY | Meaning | Example |
|---|---|---|
| **IN** | Ingredient (canonical generic) | "semaglutide" |
| **PIN** | Precise Ingredient | "semaglutide sodium" |
| **BN** | Brand Name | "Ozempic" |
| **SBD** | Semantic Branded Drug (the marketed product) | "Ozempic 0.5 mg/0.75 mL pen injector" |
| **SCD** | Semantic Clinical Drug (generic equivalent of SBD) | "semaglutide 0.5 mg/0.75 mL pen injector" |

For cross-source linking, **always prefer the IN (ingredient) RxCUI when one exists**. Brand drugs in different countries have different SBDs; the IN is global. `resolve_entity({type: "drug"})` picks the canonical RxCUI in priority order IN > PIN > BN > SBD > first available.

## Citable URIs

```
pipeworx://rxnorm/concept/{rxcui}
pipeworx://rxnorm/concept/{rxcui}/interactions
```

RxCUIs are stable and shareable.

## Update cadence

RxNorm publishes monthly updates. New drugs appear within a month of FDA approval; deprecated products are flagged but kept in the database for historical lookup. Pipeworx caches with a 24-hour TTL.

## Common pitfalls

- **Search returns SBD-only for brand queries.** Searching "Ozempic" returns Semantic Branded Drug concepts, not the ingredient. To get to "semaglutide," either search the generic name directly or call `rxnorm_related({rxcui, tty: "IN"})` on a brand RxCUI. The latter currently has bugs in some configurations — see [error recovery](https://pipeworx.io/docs/guides/error-recovery).
- **Spelling matters more than you'd think.** "metformin hydrochloride" and "metformin HCl" return slightly different concept sets. The search is forgiving for common abbreviations but exact for less common ones.
- **NDCs are different.** National Drug Codes (NDCs) are FDA-issued package-level identifiers, not RxCUIs. Use `rxnorm_ndc({rxcui})` to bridge if you need NDC for prescription-fill data.
- **Combination products.** A drug like "Kombiglyze" contains metformin + saxagliptin. Searching "metformin" may surface combination products as the top hit, which isn't what you want for ingredient-level analysis. Filter for SCD or IN, not just take the first result.
- **Discontinued drugs.** Concepts persist after a drug is withdrawn. The `obsolete` flag in the full record tells you whether the drug is currently available.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "rxnorm": {
      "url": "https://gateway.pipeworx.io/rxnorm/mcp"
    }
  }
}
```

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Rxnorm data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
