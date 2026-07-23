import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  BeforeInsert,
  BeforeUpdate,
  Index,
} from 'typeorm';
import { MCPServerHistory } from './history/MCPServerHistory';

export interface MCPSecretRef {
  credentialId: string;
  field: string;
}

export interface MCPConnectionParam {
  name: string;
  value?: string;
  secretRef?: MCPSecretRef;
  enabled?: boolean;
}

export interface MCPAuthConfig {
  location: 'header' | 'query' | 'cookie';
  keyName: string;
  prefix?: string;
  secretRef?: MCPSecretRef;
}

@Entity('mcp_servers')
@Index(['projectId', 'name'], { unique: true })
export class MCPServer {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  projectId!: string;

  @Column()
  name!: string;

  @Column('text', { nullable: true })
  description?: string;

  @Column({ type: 'varchar', length: 20, default: 'http' })
  transport!: 'http' | 'sse' | 'stdio' | 'streamable-http';

  @Column('text', { nullable: true })
  url?: string;

  @Column('text', { nullable: true })
  command?: string;

  @Column('text', { array: true, nullable: true })
  args?: string[];

  @Column('jsonb', { nullable: true })
  env?: Record<string, string>;

  @Column({ type: 'varchar', length: 30, default: 'none' })
  authType!: 'none' | 'api_key' | 'bearer_token' | 'basic' | 'oauth2';

  @Column('uuid', { nullable: true })
  credentialId?: string;

  /**
   * Credential used by the MCP runtime to authenticate to the *wrapped* system
   * (e.g. an ONTAP cluster, NetApp account). Distinct from `credentialId`,
   * which is the credential the gateway/agent uses to reach the MCP itself.
   *
   * Required for managed MCP catalog entries that declare `credentialMapping`.
   * The MCPRuntimeManager reads the credential's secret data and projects it
   * into the pod via the per-server `mcp-runtime-cred-{serverId}` Secret.
   */
  @Column('uuid', { nullable: true })
  runtimeCredentialId?: string;

  @Column('text', { nullable: true })
  authorizationUrl?: string;

  @Column('text', { nullable: true })
  tokenUrl?: string;

  @Column('jsonb', { nullable: true })
  staticHeaders?: Record<string, string>;

  @Column('jsonb', { nullable: true })
  queryParams?: MCPConnectionParam[];

  @Column('jsonb', { nullable: true })
  headerParams?: MCPConnectionParam[];

  @Column('jsonb', { nullable: true })
  authConfig?: MCPAuthConfig;

  @Column('text', { array: true, nullable: true })
  extraHeaders?: string[];

  @Column('text', { array: true, nullable: true })
  allowedTools?: string[];

  @Column('text', { array: true, nullable: true })
  disallowedTools?: string[];

  @Column('text', { nullable: true })
  specPath?: string;

  /**
   * ID returned by the LLM proxy gateway (Bifrost) for the registered MCP
   * server. The TypeScript property is named `llmproxyGateway*` to avoid
   * confusion with the AgentStudio api-gateway / apigateway-service;
   * the underlying DB column is intentionally kept as `gatewayServerId`
   * (no schema migration required for this rename).
   */
  @Column('text', { nullable: true, name: 'gatewayServerId' })
  llmproxyGatewayServerId?: string;

  /**
   * Project-namespaced server name (`{projectId}_{name}`) registered at
   * the LLM proxy gateway (Bifrost). Not the AgentStudio api-gateway.
   * DB column kept as `gatewayServerName` (see sibling field above).
   */
  @Column('text', { nullable: true, name: 'gatewayServerName' })
  llmproxyGatewayServerName?: string;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  syncStatus!: 'synced' | 'pending' | 'error' | 'suspended';

  @Column({ type: 'varchar', length: 20, default: 'unknown' })
  status!: 'connected' | 'disconnected' | 'error' | 'unknown';

  @Column('int', { default: 0 })
  consecutiveFailures!: number;

  @Column('int', { default: 600000 })
  timeout!: number;

  @Column('boolean', { default: false })
  trust!: boolean;

  @Column({ type: 'varchar', length: 20, default: 'remote' })
  deploymentType!: 'remote' | 'managed' | 'platform';

  @Column('text', { nullable: true })
  catalogId?: string;

  @Column('jsonb', { nullable: true })
  managedConfig?: {
    resourcePreset?: string;
    envOverrides?: Record<string, string>;
    volumeSize?: string;
  };

  @Column('text', { nullable: true })
  k8sResourceName?: string;

  @Column('text', { nullable: true })
  serverInstructions?: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  runtimeStatus?: 'provisioning' | 'running' | 'failed' | 'deleting';

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @OneToMany(() => MCPServerHistory, (history) => history.entity)
  history!: MCPServerHistory[];

  @BeforeInsert()
  @BeforeUpdate()
  validateConnection() {
    if (this.deploymentType === 'managed' || this.deploymentType === 'platform') return;
    if (this.transport === 'stdio' && !this.command) {
      throw new Error('command is required for stdio transport');
    }
    if ((this.transport === 'http' || this.transport === 'sse') && !this.url) {
      throw new Error('url is required for http/sse transport');
    }
  }
}
