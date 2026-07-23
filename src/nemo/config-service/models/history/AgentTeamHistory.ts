import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { AgentTeam } from '../AgentTeam';

@Entity('agent_team_history')
@Index(['entityId', 'version'], { unique: true })
export class AgentTeamHistory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('varchar', { length: 12 })
  entityId!: string;

  @ManyToOne(() => AgentTeam, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'entityId' })
  entity!: AgentTeam;

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
