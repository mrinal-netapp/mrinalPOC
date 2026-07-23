import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Agent } from '../Agent';

@Entity('agent_history')
@Index(['entityId', 'version'], { unique: true })
export class AgentHistory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('varchar', { length: 11 })
  entityId!: string;

  @ManyToOne(() => Agent, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'entityId' })
  entity!: Agent;

  @Column('int')
  version!: number;

  @Column('jsonb')
  data!: any;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  modifiedAt!: Date;

  @Column('text', { nullable: true })
  modifiedBy?: string;

  @Column('text', { nullable: true })
  op?: string;
}
