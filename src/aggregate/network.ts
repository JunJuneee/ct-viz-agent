import {
  NetworkEdge,
  NetworkEntity,
  NetworkNode,
  NormalizedStudy,
} from "../types";
import { config } from "../config";
import { STUDY_URL } from "../clinicaltrials/fields";

const MAX_NODES_PER_GROUP = 30;
const MAX_EDGES = 120;

/** Extract the entities of a given kind from a study (deduped, cleaned). */
function entities(study: NormalizedStudy, kind: NetworkEntity): string[] {
  switch (kind) {
    case "sponsor":
      return study.leadSponsor ? [study.leadSponsor] : [];
    case "condition":
      return Array.from(new Set(study.conditions));
    case "drug": {
      // Prefer DRUG/BIOLOGICAL interventions; fall back to all named ones.
      const drugs = study.interventions
        .filter((i) => i.type === "DRUG" || i.type === "BIOLOGICAL")
        .map((i) => i.name);
      const names = drugs.length ? drugs : study.interventions.map((i) => i.name);
      return Array.from(new Set(names));
    }
    default:
      return [];
  }
}

interface EdgeAcc {
  source: string;
  target: string;
  weight: number;
  studies: NormalizedStudy[];
}

export interface NetworkResult {
  nodes: NetworkNode[];
  edges: NetworkEdge[];
  truncated: boolean;
}

/**
 * Build a relationship network. When source !== target the graph is bipartite
 * (e.g. sponsor↔drug). When source === target it is a co-occurrence graph
 * (e.g. drug↔drug pairs appearing in the same trial). Node/edge counts are
 * capped to remain renderable; edge weights = number of trials in common.
 */
export function buildNetwork(
  studies: NormalizedStudy[],
  source: NetworkEntity,
  target: NetworkEntity,
): NetworkResult {
  const edgeMap = new Map<string, EdgeAcc>();
  const nodeWeight = new Map<string, { group: NetworkEntity; weight: Set<string> }>();

  const bump = (id: string, group: NetworkEntity, nctId: string) => {
    let n = nodeWeight.get(id);
    if (!n) {
      n = { group, weight: new Set() };
      nodeWeight.set(id, n);
    }
    n.weight.add(nctId);
  };

  for (const study of studies) {
    if (source === target) {
      const items = entities(study, source);
      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          addEdge(edgeMap, source, items[i], source, items[j], study, bump);
        }
      }
    } else {
      const ss = entities(study, source);
      const ts = entities(study, target);
      for (const s of ss) {
        for (const t of ts) {
          addEdge(edgeMap, source, s, target, t, study, bump);
        }
      }
    }
  }

  // Rank edges by weight; keep the strongest, then keep only their nodes.
  const allEdges = Array.from(edgeMap.values()).sort((a, b) => b.weight - a.weight);
  const keptEdges = allEdges.slice(0, MAX_EDGES);
  const keptNodeIds = new Set<string>();
  for (const e of keptEdges) {
    keptNodeIds.add(e.source);
    keptNodeIds.add(e.target);
  }

  const nodes: NetworkNode[] = Array.from(nodeWeight.entries())
    .filter(([id]) => keptNodeIds.has(id))
    .map(([id, info]) => ({
      id,
      label: stripGroupPrefix(id),
      group: info.group,
      weight: info.weight.size,
    }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_NODES_PER_GROUP * 2);

  const finalNodeIds = new Set(nodes.map((n) => n.id));
  const edges: NetworkEdge[] = keptEdges
    .filter((e) => finalNodeIds.has(e.source) && finalNodeIds.has(e.target))
    .map((e) => ({
      source: e.source,
      target: e.target,
      weight: e.weight,
      citations: e.studies.slice(0, config.maxCitationsPerDatum).map((s) => ({
        nct_id: s.nctId,
        excerpt: `${stripGroupPrefix(e.source)} ↔ ${stripGroupPrefix(e.target)} — "${s.briefTitle || s.nctId}"`,
        url: STUDY_URL(s.nctId),
      })),
    }));

  return {
    nodes,
    edges,
    truncated: allEdges.length > keptEdges.length,
  };
}

function addEdge(
  edgeMap: Map<string, EdgeAcc>,
  sGroup: NetworkEntity,
  sName: string,
  tGroup: NetworkEntity,
  tName: string,
  study: NormalizedStudy,
  bump: (id: string, group: NetworkEntity, nctId: string) => void,
): void {
  // Namespace node ids by group so a sponsor and a drug with the same string
  // never collide.
  const sId = `${sGroup}:${sName}`;
  const tId = `${tGroup}:${tName}`;
  bump(sId, sGroup, study.nctId);
  bump(tId, tGroup, study.nctId);

  const [a, b] = [sId, tId].sort(); // stable key for undirected edges.
  const key = `${a}|${b}`;
  let acc = edgeMap.get(key);
  if (!acc) {
    acc = { source: a, target: b, weight: 0, studies: [] };
    edgeMap.set(key, acc);
  }
  acc.weight++;
  if (acc.studies.length < config.maxCitationsPerDatum) acc.studies.push(study);
}

const stripGroupPrefix = (id: string): string => id.replace(/^[^:]+:/, "");
