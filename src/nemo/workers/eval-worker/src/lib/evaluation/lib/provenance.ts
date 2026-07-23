// Provenance envelope resolved by orchestration-service at POST /evaluations
// time (spec §5.2). Pinned in EvaluationJobInput; frozen for the job's lifetime.

export interface ProvenanceEnvelope {
  agentVersionHash: string;
  datasetVersion: string;
  retrievalIndexVersion: string;
  toolRegistryVersion: string;
  generatorModelVersion: string;
  evaluatorModel?: string;
  evaluatorVersion?: string;
  rubricIds: string[];
  rubricPrompts: Array<{ id: string; prompt: string }>;
  envelopeHash: string;
}
