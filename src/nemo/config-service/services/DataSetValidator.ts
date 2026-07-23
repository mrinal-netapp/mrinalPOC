import { ValidationError, BusinessLogicError, ConflictError } from '../utils/errors';
import { DataSet } from '../models/DataSet';
import { CreateDataSetRequest, UpdateDataSetRequest } from './DataSetService';
import { validateDatasetName } from '../utils/datasetNameValidation';
import { AppDataSource } from '../db/postgres';
import { Not } from 'typeorm';

const dataSetRepo = () => AppDataSource.getRepository(DataSet);

/**
 * Validator for dataset operations
 * Extracted from DataSetService for separation of concerns
 */
export class DataSetValidator {
  /**
   * Validate dataset creation request.
   * Storage bucket is derived from the project home_dir in DataSetService.createDataSet.
   */
  static validateCreateRequest(projectId: string, data: CreateDataSetRequest): void {
    if (!projectId) {
      throw new ValidationError('projectId is required');
    }

    // Validate dataset name for use as table identifier
    const nameValidation = validateDatasetName(data.name);
    if (!nameValidation.valid) {
      throw new ValidationError(
        nameValidation.error || 'Invalid dataset name. ' +
        (nameValidation.sanitized ? `Suggested name: ${nameValidation.sanitized}` : '')
      );
    }
  }

  /**
   * Check for duplicate dataset name
   */
  static async checkDuplicateName(projectId: string, name: string, excludeId?: string): Promise<void> {
    const repo = dataSetRepo();
    const where: any = { projectId, name };
    if (excludeId) {
      where.id = Not(excludeId);
    }
    const exists = await repo.findOne({ where });
    if (exists) {
      throw new ConflictError('DataSet with this name already exists in this project');
    }
  }

  /**
   * Validate dataset update (business rules)
   */
  static validateUpdate(currentDataSet: DataSet, updateData: UpdateDataSetRequest): void {
    // Prevent changing type and kind after creation (bucket is server-managed only).
    if (updateData.type !== undefined && updateData.type !== currentDataSet.type) {
      throw new BusinessLogicError('Cannot change dataset type after creation');
    }
    if (updateData.kind !== undefined && updateData.kind !== currentDataSet.kind) {
      throw new BusinessLogicError('Cannot change dataset kind after creation');
    }

    // Prevent name changes if catalog table exists
    if (updateData.name && updateData.name !== currentDataSet.name && currentDataSet.catalogTableName) {
      throw new ValidationError(
        'Cannot change dataset name after catalog table has been created. ' +
        'The catalog table name is based on the dataset name.'
      );
    }
  }
}
