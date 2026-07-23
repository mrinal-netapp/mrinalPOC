// Golden dataset / test case schema (spec §5.1).

export type CaseCategory =
  | 'happy_path'
  | 'edge_case'
  | 'adversarial'
  | 'safety'
  | 'regression'
  | 'label_suspect';

export type Difficulty = 'easy' | 'medium' | 'hard';

export interface Assertion {
  pattern: string;
  match: 'substring' | 'regex' | 'semantic';
  p0?: boolean;
}

export interface CitationAssertion {
  id: string;
  required: boolean;
}

export interface ReferenceContextEntry {
  id: string;
  uri?: string;
  title?: string;
}

export interface Attachment {
  type: 'file' | 'image' | 'turn' | 'tool_output';
  ref: string;
  role?: 'user' | 'system';
}

export interface SubAgentExpectation {
  name: string;
  required_schema?: Record<string, unknown>;
  expected_output?: Record<string, unknown>;
  must_include?: Assertion[];
  must_not_include?: Assertion[];
}

export interface GoldenTestCase {
  id: string;
  category?: CaseCategory;
  difficulty?: Difficulty;
  tags?: string[];
  label_suspect?: boolean;

  input: {
    query: string;
    attachments?: Attachment[];
    context_hints?: string[];
  };

  evaluation: {
    reference_context?: ReferenceContextEntry[];

    retrieval_expectation?: {
      relevant_document_ids: string[];
      irrelevant_document_ids?: string[];
      min_relevant_k?: number;
    };

    expected_tool_use?: {
      expected_tools: Array<{
        name: string;
        requiredArgs?: Record<string, unknown>;
        requiredArgsSchema?: Record<string, unknown>;
      }>;
      expected_plan?: Array<{ step: number; tool: string; notes?: string }>;
      forbidden_tools?: string[];
    };

    safety_expectation?: {
      should_refuse: boolean;
      tricky?: boolean;
      forbidden_topics?: string[];
      allowed_refusal_reasons?: string[];
    };

    classification_labels?: {
      should_retrieve?: boolean;
      should_call_tool?: boolean;
      correct_class?: string;
    };

    sla?: {
      maxE2eMs?: number;
      maxTtftMs?: number;
    };

    budget?: {
      maxCostUsd?: number;
    };

    expected_response: {
      final: {
        expected_answer?: string;
        reference_text?: string;
        required_schema?: Record<string, unknown>;
        must_include?: Assertion[];
        must_cite?: CitationAssertion[];
        forbidden?: Assertion[];
      };
      sub_agents?: SubAgentExpectation[];
    };
  };

  origin?: 'legacy_csv' | 'golden_test_v1';
}

export interface CaseDefaults {
  category?: CaseCategory;
  difficulty?: Difficulty;
  tags?: string[];
  retrieval_expectation?: GoldenTestCase['evaluation']['retrieval_expectation'];
  expected_tool_use?: GoldenTestCase['evaluation']['expected_tool_use'];
  safety_expectation?: GoldenTestCase['evaluation']['safety_expectation'];
  classification_labels?: GoldenTestCase['evaluation']['classification_labels'];
  sla?: GoldenTestCase['evaluation']['sla'];
  budget?: GoldenTestCase['evaluation']['budget'];
  forbidden?: Assertion[];
  must_cite?: CitationAssertion[];
}

export interface GoldenTestDataset {
  datasetId: string;
  schemaVersion: 'golden_test_v1' | 'flat_csv_legacy';
  datasetVersion: string;
  origin: 'golden_test_v1' | 'flat_csv' | 'legacy_csv';
  rowCount: number;
  defaults?: CaseDefaults;
}
