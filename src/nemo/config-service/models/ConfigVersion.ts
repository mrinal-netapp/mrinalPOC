import { Entity, PrimaryColumn, Column } from 'typeorm';

@Entity('config_version')
export class ConfigVersion {
  @PrimaryColumn({ type: 'integer', default: 1 })
  id!: number;

  @Column({ type: 'integer', default: 1 })
  version!: number;
}

