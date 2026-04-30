/**
 * MG MedTracker — Netlify Function: check-interactions
 *
 * Pipeline:
 *   1. Map EU brand names → INN via RxNorm
 *   2. Fetch OpenFDA drug labels for each medication
 *   3. Ask Claude (claude-sonnet-4-20250514) for MG-specific interaction analysis
 *
 * Environment variable required: ANTHROPIC_API_KEY
 */

const Anthropic = require("@anthropic-ai/sdk");

// ── EU brand → INN lookup (extend as needed) ─────────────────────────────────
const EU_BRAND_MAP = {
  mestinon: "pyridostigmine",
  "mestinon retard": "pyridostigmine",
  imurel: "azathioprine",
  cellcept: "mycophenolate mofetil",
  prograf: "tacrolimus",
  medrol: "methylprednisolone",
  decortin: "prednisone",
  "decortin h": "prednisolone",
  urbason: "methylprednisolone",
  sandimmun: "cyclosporine",
  neoral: "cyclosporine",
  rituxan: "rituximab",
  mabthera: "rituximab",
  soliris: "eculizumab",
  ultomiris: "ravulizumab",
  vyvgart: "efgartigimod",
  rystiggo: "rozanolixizumab",
};

// ── OpenFDA label fetcher ────────────────────────────────────────────────────
async function fetchFDALabel(name) {
  try {
    const url = `https://api.fda.gov/drug/label.json?search=openfda.generic_name:"${encodeURIComponent(name)}"&limit=1`;
    const res = await fetch(url);
    const json = await res.json();
    const label = json.results?.[0];
    if (!label) return null;
    return {
      warnings: label.warnings?.[0]?.slice(0, 600) ?? "",
      drugInteractions: label.drug_interactions?.[0]?.slice(0, 600) ?? "",
    };
  } catch {
    return null;
  }
}

// ── RxNorm brand → ingredient resolver ──────────────────────────────────────
async function resolveIngredient(name) {
  const lower = name.trim().toLowerCase();
  const mapped = EU_BRAND_MAP[lower];
  const lookupName = mapped ?? name.trim();
  try {
    const res = await fetch(
      `https://rxnav.nlm.nih.gov/REST/rxcui.json?name=${encodeURIComponent(lookupName)}&search=1`
    );
    const json = await res.json();
    const rxcui = json.idGroup?.rxnormId?.[0];
    if (!rxcui) return { resolved: lookupName, euMapped: mapped ?? null };

    const propRes = await fetch(
      `https://rxnav.nlm.nih.gov/REST/rxcui/${rxcui}/properties.json`
    );
    const propJson = await propRes.json();
    const tty = propJson.properties?.tty ?? "";
    const resolvedName = propJson.properties?.name ?? lookupName;

    // If it resolved to a branded product, drill down to ingredient
    if (["SBD", "BPCK", "SCD", "SCDC"].includes(tty)) {
      const relRes = await fetch(
        `https://rxnav.nlm.nih.gov/REST/rxcui/${rxcui}/related.json?tty=IN`
      );
      const relJson = await relRes.json();
      const ingredient = relJson.relatedGroup?.conceptGroup?.find(
        (g) => g.tty === "IN"
      )?.conceptProperties?.[0];
      if (ingredient) return { resolved: ingredient.name, euMapped: mapped ?? null };
    }
    return { resolved: resolvedName, euMapped: mapped ?? null };
  } catch {
    return { resolved: lookupName, euMapped: mapped ?? null };
  }
}

// ── System prompt ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a clinical pharmacist reviewing a Myasthenia Gravis (MG) patient's complete medication list for interactions.

Apply MG-specific pharmacology:
- Flag drugs that worsen NMJ transmission: aminoglycosides, fluoroquinolones, macrolides, beta-blockers, calcium-channel blockers, magnesium, neuromuscular blockers, chloroquine/hydroxychloroquine, d-penicillamine, statins (at high doses), colistin, quinine, procainamide.
- Note immunosuppressant combinations (azathioprine + mycophenolate → additive myelosuppression; cyclosporine + tacrolimus → nephrotoxicity).
- Consider pyridostigmine (Mestinon) timing sensitivity and cholinergic crisis risk.

Respond ONLY with a JSON object — no prose, no markdown fences:
{
  "severity": "contraindicated" | "caution" | "monitor" | "ok",
  "summary": "<2-sentence plain English summary for an elderly patient>",
  "interactions": [
    {
      "drugs": ["drug A", "drug B"],
      "severity": "contraindicated" | "caution" | "monitor",
      "mechanism": "<brief mechanism>",
      "recommendation": "<clear action>"
    }
  ],
  "mgSpecificRisks": ["<risk 1>", "<risk 2>"]
}`;

// ── Handler ──────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }),
    };
  }

  let medications;
  try {
    ({ medications } = JSON.parse(event.body));
    if (!Array.isArray(medications) || medications.length === 0) throw new Error();
  } catch {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Provide a non-empty medications array" }),
    };
  }

  // 1. Resolve all drug names in parallel
  const resolved = await Promise.all(
    medications.map(async (med) => {
      const { resolved, euMapped } = await resolveIngredient(med.name);
      const fdaLabel = await fetchFDALabel(resolved);
      return {
        original: med.name,
        resolved,
        euMapped,
        dose: med.dose ?? "",
        frequency: med.frequency ?? "",
        fdaWarnings: fdaLabel?.warnings ?? "",
        fdaDrugInteractions: fdaLabel?.drugInteractions ?? "",
      };
    })
  );

  // 2. Build user message
  const medList = resolved
    .map(
      (m, i) =>
        `${i + 1}. ${m.original}${m.euMapped ? ` (EU brand → ${m.resolved})` : m.resolved !== m.original ? ` (resolved: ${m.resolved})` : ""}` +
        (m.dose ? ` ${m.dose}` : "") +
        (m.frequency ? ` ${m.frequency}` : "") +
        (m.fdaWarnings ? `\n   FDA warnings excerpt: ${m.fdaWarnings}` : "") +
        (m.fdaDrugInteractions ? `\n   FDA interactions excerpt: ${m.fdaDrugInteractions}` : "")
    )
    .join("\n\n");

  const userMessage = `Patient has Myasthenia Gravis. Current medication list:\n\n${medList}\n\nProvide interaction analysis as JSON.`;

  // 3. Call Claude
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1500,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  const rawText = response.content[0]?.text ?? "{}";
  let result;
  try {
    result = JSON.parse(rawText.replace(/```json|```/g, "").trim());
  } catch {
    result = { severity: "ok", summary: rawText, interactions: [], mgSpecificRisks: [] };
  }

  // Attach resolved names for UI display
  result.resolvedMedications = resolved.map((m) => ({
    original: m.original,
    resolved: m.resolved,
    euMapped: m.euMapped,
  }));

  return { statusCode: 200, headers, body: JSON.stringify(result) };
};
