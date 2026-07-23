import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { ModelHistory } from './history/ModelHistory';

@Entity('models')
@Index(['projectId', 'name'], { unique: true })
export class Model {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  projectId!: string;

  @Column()
  name!: string;

  @Column({ nullable: true })
  displayName?: string;

  /**
   * Free-form JSONB carrying model metadata. Shape varies by `modelType`:
   *   - llm:       { architecture, base_model, variant, parameters, quantization, size, ... }
   *   - embedding: { dimensions, recommendedChunkSize, category, description, ... }
   * `Record<string, unknown>` (not `any`) forces consumers to narrow by
   * `modelType` and assert types before reading — typos like
   * `model_info?.architechture` then fail compilation instead of returning
   * `undefined` silently.
   */
  @Column('jsonb', { nullable: true })
  model_info?: Record<string, unknown>;

  @Column({ nullable: true })
  endpoint?: string;

  @Column('jsonb', { nullable: true })
  auth?: {
    access_token: string;
    secret_key: string;
  };

  @Column('jsonb', { nullable: true })
  limits?: {
    tpm: number;
    timeout: number;
    stream_timeout: number;
    max_retries: number;
  };

  /** Provider identifier: openai, aws_bedrock, azure, google, local */
  @Column({ nullable: true })
  provider?: string;

  /** The model ID as known by the provider (e.g. gpt-4, amazon.titan-embed-text-v1) */
  @Column({ nullable: true })
  providerModelId?: string;

  /**
   * Ready-to-send model id for the LLM gateway (Bifrost). Computed at
   * registration time as `<bifrost-provider>/<gatewayBindingName>` (or
   * `<bifrost-provider>/<providerModelId>` for legacy rows pre-dating the
   * binding-name column), e.g. `azure/projm5ehnnub_f1c94b5a_gpt-5.4`.
   * Callers (agent-service, playground infer fallback, MCP tool runs)
   * consume this verbatim so the provider prefix required by Bifrost
   * lives in config, not in each runtime hop.
   */
  @Column({ nullable: true })
  gatewayModelId?: string;

  /**
   * Unique Bifrost-side identifier for this (project, credential, model)
   * combination, computed at registration time as
   * `<projectId>_<credentialShortId>_<providerModelId>` (or
   * `<projectId>_<providerModelId>` when there is no credential, e.g. the
   * local provider). This is what we put into the Bifrost provider key's
   * `models[]`, the provider deployment-routing map key (when the gateway
   * provider exposes one), the routing rule's CEL
   * (`request.model == "<gatewayBindingName>"`), and the project virtual
   * key's `allowed_models[]`. Distinct from `providerModelId` (the bare
   * upstream id Bifrost forwards to the provider) and from
   * `providerDeploymentName` (the upstream inference/deployment id when it
   * differs from `providerModelId`). Stored so future edit/rate-limit/budget
   * flows can look up the Bifrost entries without recomputing.
   */
  @Column({ nullable: true })
  gatewayBindingName?: string;

  /**
   * Deployment/inference name on the upstream provider when it differs from the
   * model id (e.g. a cloud deployment id that does not match the catalog model id).
   * Provider-specific gateway config (e.g. Bifrost `azure_key_config.deployments`)
   * uses this when set; otherwise routing falls back to identity
   * (`providerModelId` == deployment).
   */
  @Column({ nullable: true })
  providerDeploymentName?: string;

  /** Reference to a Credential entity for remote providers */
  @Column({ type: 'uuid', nullable: true })
  credentialId?: string;

  /** Model type: llm or embedding */
  @Column({ nullable: true })
  modelType?: string;

  /**
   * System-managed built-in model (e.g., in-cluster TEI embedding models).
   * True for catalog entries seeded by `BuiltinModelsService`; false for
   * user-registered remote models. Built-ins are immutable from the user
   * surface — `PUT /models/:id` and `DELETE /models/:id` will reject them
   * once Phase 2 implements the route-level guards.
   *
   * The class-field initializer (`= false`) gives a runtime default for
   * objects constructed via `new Model()` or `repo.create({...})` without
   * specifying isBuiltin — the DB column default also defaults to false
   * for legacy INSERT paths that don't include the column.
   */
  @Column({ type: 'boolean', default: false })
  isBuiltin: boolean = false;

  /** Functional classification (e.g. "reasoning", "balanced", "fast", "code") */
  @Column({ nullable: true })
  modelClass?: string;

  /** Custom rate/pricing overrides (jsonb) */
  @Column('jsonb', { nullable: true })
  rateCardOverride?: Record<string, any>;

  /** Requests per minute. Null = no per-model RPM limit. */
  @Column({ type: 'int', nullable: true })
  rpm?: number;

  /**
   * Tokens per minute. Null = no per-model TPM limit. Promoted from the
   * nested `limits.tpm` field, which is kept for back-compat. New
   * clients should write the top-level column; readers that need a
   * value can fall back to `limits?.tpm` for legacy rows.
   */
  @Column({ type: 'int', nullable: true })
  tpm?: number;

  /** Spending cap, in USD, evaluated over the window in `spendingLimitPeriod`. */
  @Column({ type: 'float', nullable: true })
  spendingLimit?: number;

  /** Window for `spendingLimit`. Only meaningful when spendingLimit is set. */
  @Column({ type: 'varchar', length: 8, nullable: true })
  spendingLimitPeriod?: 'day' | 'week' | 'month';

  /** Custom input price, USD per 1M input tokens. Null = use provider list price. */
  @Column({ type: 'float', nullable: true })
  inputCostPer1M?: number;

  /** Custom output price, USD per 1M output tokens. Null = use provider list price. */
  @Column({ type: 'float', nullable: true })
  outputCostPer1M?: number;

  /** Markup percent applied on top of (input + output) cost. e.g. 15 means +15%. */
  @Column({ type: 'float', nullable: true })
  markupPercent?: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @OneToMany(() => ModelHistory, (history) => history.entity)
  history!: ModelHistory[];
}
