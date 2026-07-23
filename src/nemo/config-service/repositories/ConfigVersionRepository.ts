import { Repository, DataSource } from 'typeorm';
import { ConfigVersion } from '../models/ConfigVersion';

export class ConfigVersionRepository {
  private repo: Repository<ConfigVersion>;

  constructor(dataSource: DataSource) {
    this.repo = dataSource.getRepository(ConfigVersion);
  }

  async getVersion(): Promise<number> {
    const config = await this.repo.findOne({ where: { id: 1 } });
    if (!config) {
      return 1;
    }
    return config.version;
  }

  async incrementVersion(): Promise<number> {
    const config = await this.repo.findOne({ where: { id: 1 } });
    if (!config) {
      const newConfig = this.repo.create({ id: 1, version: 2 });
      await this.repo.save(newConfig);
      return 2;
    }
    config.version += 1;
    const updated = await this.repo.save(config);
    return updated.version;
  }
}

