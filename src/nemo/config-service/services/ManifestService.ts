import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import { AppDataSource } from '../db/postgres';
import { DataSetManifest } from '../models/DataSetManifest';
import { DataSetManifestFile } from '../models/DataSetManifestFile';
import { DataSet } from '../models/DataSet';
import { Project as ProjectEntity } from '../models/Project';
import { ManifestStatus } from '../models/DataSetManifest';
import { v4 as uuidv4 } from 'uuid';
import { generatePresignedUrl, s3Client, S3_CONFIG } from '../utils/s3Utils';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getRepositoryFactory } from '../repositories/RepositoryFactory';
import { BucketRoutingResponse, RoutingDeploymentInfo } from '../types/deployment';
import { BaseService } from './BaseService';
import { DeploymentService } from './DeploymentService';
import { DeploymentEndpointService } from './DeploymentEndpointService';
import { NotFoundError, BusinessLogicError, ValidationError, PayloadTooLargeError } from '../utils/errors';
import { getProjectStorageRoot } from '../utils/defaultBucket';
import { DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { LakekeeperCatalogService } from './LakekeeperCatalogService';

const manifestRepo = () => AppDataSource.getRepository(DataSetManifest);
const fileRepo = () => AppDataSource.getRepository(DataSetManifestFile);
const dataSetRepo = () => AppDataSource.getRepository(DataSet);
const catalogService = new LakekeeperCatalogService();

/**
 * Manual-upload caps (env-driven). Defaults:
 *   MANUAL_UPLOAD_MAX_FILES_PER_DATASET = 50000
 *
 * The file-count bound applies across all draft + committed manifests of a
 * single dataset (additive). 0 disables the cap (use sparingly).
 *
 * Per-file byte size is not enforced here — file sizes are only known at
 * upload time (the manifest API receives names + URIs, not sizes) and are
 * gated by S3 presigned-URL policies and the deployment endpoint. Add a
 * `maxFileBytes` cap here only when a size value is actually plumbed
 * through.
 */
function manualUploadLimits(): { maxFilesPerDataset: number } {
  const maxFilesPerDataset = Number.parseInt(process.env.MANUAL_UPLOAD_MAX_FILES_PER_DATASET || '', 10);
  return {
    maxFilesPerDataset: Number.isFinite(maxFilesPerDataset) && maxFilesPerDataset >= 0 ? maxFilesPerDataset : 50_000,
  };
}

/**
 * Verify dataset exists
 */
async function verifyDataSetExists(dataSetId: string): Promise<void> {
  const dataSet = await dataSetRepo().findOne({ where: { id: dataSetId } });
  if (!dataSet) {
    throw new NotFoundError('DataSet', dataSetId);
  }
}

/**
 * Check if draft manifest exists for dataset
 */
async function checkDraftManifestExists(dataSetId: string): Promise<void> {
  const existingDraft = await manifestRepo().findOne({
    where: { dataSetId, status: 'draft' },
  });
  if (existingDraft) {
    throw new BusinessLogicError('A draft manifest already exists for this dataset. Only one draft manifest is allowed per dataset.');
  }
}

/**
 * Get manifest by ID with validation
 */
async function getManifestOrThrow(manifestId: string): Promise<DataSetManifest> {
  const manifest = await manifestRepo().findOne({
    where: { id: manifestId },
  });
  if (!manifest) {
    throw new NotFoundError('Manifest', manifestId);
  }
  return manifest;
}

/**
 * Validate manifest is in draft status
 */
function validateDraftStatus(manifest: DataSetManifest, operation: string): void {
  if (manifest.status !== 'draft') {
    throw new BusinessLogicError(`Cannot ${operation} manifest with status ${manifest.status}. Only draft manifests can be modified.`);
  }
}

/**
 * Extract file name from URI
 * Handles both s3://bucket/path/to/file.ext and regular paths
 * For backward compatibility, returns just the basename.
 */
function extractFileNameFromUri(uri: string): string {
  // Remove s3:// prefix if present
  const path = uri.replace(/^s3:\/\//, '');
  // Extract filename (everything after last /)
  const fileName = path.split('/').pop() || uri;
  return fileName;
}

/**
 * Extract the relative path under data_files/ from a URI.
 * For URIs like s3://bucket/.../data_files/dir1/file.txt returns "dir1/file.txt".
 * Falls back to extractFileNameFromUri (basename) if data_files/ is not found.
 * This allows files with the same basename in different directories to coexist.
 */
function extractRelativePathFromUri(uri: string): string {
  // Remove s3:// prefix if present
  const cleanPath = uri.replace(/^s3:\/\/[^/]+\//, '');
  const marker = 'data_files/';
  const markerIndex = cleanPath.indexOf(marker);
  if (markerIndex !== -1) {
    const relativePath = cleanPath.substring(markerIndex + marker.length);
    if (relativePath) {
      return relativePath;
    }
  }
  // Fallback to basename
  return extractFileNameFromUri(uri);
}

/**
 * Validate that file paths are unique within a list of URIs.
 * Uses the relative path under data_files/ (not just basename) so that files with
 * the same name in different directories (e.g. dir1/file.txt, dir2/file.txt) are allowed.
 * Throws ValidationError with details if duplicates are found.
 */
function validateUniqueFileNames(uris: string[]): void {
  const filePathMap = new Map<string, number[]>();
  
  // Extract relative paths and track their indices
  uris.forEach((uri, index) => {
    const relativePath = extractRelativePathFromUri(uri);
    if (!filePathMap.has(relativePath)) {
      filePathMap.set(relativePath, []);
    }
    filePathMap.get(relativePath)!.push(index);
  });
  
  // Find duplicates
  const duplicates: Array<{ fileName: string; indices: number[]; uris: string[] }> = [];
  filePathMap.forEach((indices, relativePath) => {
    if (indices.length > 1) {
      duplicates.push({
        fileName: relativePath,
        indices,
        uris: indices.map(i => uris[i]),
      });
    }
  });
  
  if (duplicates.length > 0) {
    const duplicateDetails = duplicates.map(dup => 
      `"${dup.fileName}" appears ${dup.indices.length} times (at positions ${dup.indices.map(i => i + 1).join(', ')})`
    ).join('; ');
    
    throw new ValidationError(
      `Duplicate file paths detected. Files with the same path will overwrite each other in S3. ` +
      `Please rename the files before uploading. Duplicates: ${duplicateDetails}`
    );
  }
}

/**
 * Validate that file paths are unique when adding to an existing manifest
 * Checks against both new files and existing files in the manifest.
 * Compares by fileName (which now stores the relative path under data_files/).
 */
async function validateUniqueFileNamesInManifest(
  manifestId: string,
  newFileNames: string[]
): Promise<void> {
  // Get existing files in the manifest
  const existingFiles = await fileRepo().find({
    where: { manifestId },
  });
  
  const existingFileNames = new Set(existingFiles.map(f => f.fileName));
  
  // Check for duplicates within new files
  validateUniqueFileNames(newFileNames.map(name => `s3://dummy/data_files/${name}`));
  
  // Check for conflicts with existing files
  const conflicts: string[] = [];
  newFileNames.forEach(fileName => {
    if (existingFileNames.has(fileName)) {
      conflicts.push(fileName);
    }
  });
  
  if (conflicts.length > 0) {
    throw new ValidationError(
      `File path conflicts detected. The following files already exist in this manifest: ${conflicts.join(', ')}. ` +
      `Please use different file names or directories.`
    );
  }
}

export class ManifestService extends BaseService {
  /**
   * Get the next manifest ID for a dataset (monotonically increasing)
   */
  static async getNextManifestId(dataSetId: string): Promise<number> {
    const lastManifest = await manifestRepo().findOne({
      where: { dataSetId },
      order: { manifestId: 'DESC' },
    });
    return lastManifest ? lastManifest.manifestId + 1 : 1;
  }

  /**
   * Create a new manifest for a dataset
   */
  static async createManifest(
    dataSetId: string,
    uris: string[] = [],
    metadata?: Record<string, any>,
    schema?: Record<string, any>
  ): Promise<DataSetManifest> {
    await verifyDataSetExists(dataSetId);
    await checkDraftManifestExists(dataSetId);

    // Validate that file names are unique
    if (uris.length > 0) {
      validateUniqueFileNames(uris);
    }

    const manifestId = await this.getNextManifestId(dataSetId);

    // Create manifest
    const manifest = manifestRepo().create({
      dataSetId,
      manifestId,
      status: 'draft',
      metadata: metadata || {},
      schema: schema,
    });
    const savedManifest = await manifestRepo().save(manifest);

    // Create file records if URIs provided
    // Files are already uploaded to S3 by the frontend, we just store the URIs
    // No S3 connection needed - URIs contain full bucket and path information
    // fileName stores the relative path under data_files/ to support directory uploads
    if (uris.length > 0) {
      const fileRecords = uris.map((uri) => {
        const fileName = extractRelativePathFromUri(uri);
        return fileRepo().create({
          manifestId: savedManifest.id,
          fileName,
          uri,
        });
      });
      await fileRepo().save(fileRecords);
    }

    // Reload with relations
    return await this.getManifest(savedManifest.id) as DataSetManifest;
  }

  /**
   * Add files to a manifest (only if status is draft)
   * Returns array of file info with pre-signed URLs
   * Note: This requires S3 connection to generate pre-signed URLs.
   * If S3 is not available, use createManifest with file URIs instead.
   */
  /**
   * Count files registered in the dataset's currently-live manifests (any open
   * draft + the current committed manifest). Excludes 'deprecated' manifests —
   * manifests superseded by a later commit (see updateManifestStatus) — so this
   * reflects the dataset's current file set rather than accumulating file
   * counts from every manifest version ever created for the dataset.
   * Used both to enforce the per-dataset manual-upload cap and to compute the
   * displayed file count (dataset.stats.sourceFileCount).
   */
  static async countFiles(dataSetId: string): Promise<number> {
    const rows = await fileRepo()
      .createQueryBuilder('f')
      .innerJoin(DataSetManifest, 'm', 'm.id = f."manifestId"')
      .where('m."dataSetId" = :dataSetId', { dataSetId })
      .andWhere('m.status != :deprecated', { deprecated: 'deprecated' })
      .select('COUNT(*)', 'count')
      .getRawOne<{ count: string }>();
    return Number(rows?.count ?? 0);
  }

  /**
   * Enforce the per-dataset manual-upload file-count cap.
   * Throws PayloadTooLargeError when the cap would be exceeded.
   * Passing `excludeManifestId` skips that manifest's files from the running
   * count so "replace" operations are evaluated against the post-replace state.
   * Excludes 'deprecated' manifests — see countFiles() for why.
   */
  private static async enforceFileCountCap(
    dataSetId: string,
    incomingCount: number,
    excludeManifestId?: string,
  ): Promise<void> {
    const { maxFilesPerDataset } = manualUploadLimits();
    if (maxFilesPerDataset === 0) return;

    const qb = fileRepo()
      .createQueryBuilder('f')
      .innerJoin(DataSetManifest, 'm', 'm.id = f."manifestId"')
      .where('m."dataSetId" = :dataSetId', { dataSetId })
      .andWhere('m.status != :deprecated', { deprecated: 'deprecated' });
    if (excludeManifestId) {
      qb.andWhere('f."manifestId" != :excludeManifestId', { excludeManifestId });
    }
    const row = await qb.select('COUNT(*)', 'count').getRawOne<{ count: string }>();
    const existing = Number(row?.count ?? 0);
    const total = existing + incomingCount;
    if (total > maxFilesPerDataset) {
      throw new PayloadTooLargeError(
        `Dataset file count cap exceeded: requested ${total} files, limit is ${maxFilesPerDataset}. ` +
        `Set MANUAL_UPLOAD_MAX_FILES_PER_DATASET to override.`,
      );
    }
  }

  static async addFilesToManifest(
    manifestId: string,
    fileNames: string[],
    bucketName?: string
  ): Promise<Array<{ id: string; preSignedUrl: string; fileName: string }>> {
    const manifest = await getManifestOrThrow(manifestId);
    validateDraftStatus(manifest, 'add files to');

    // Validate that file names are unique (both within new files and against existing files)
    if (fileNames.length > 0) {
      await validateUniqueFileNamesInManifest(manifestId, fileNames);
    }

    await this.enforceFileCountCap(manifest.dataSetId, fileNames.length);

    // Get bucket from dataset (preferred) or use provided bucket parameter
    let bucket: string | null = bucketName || null;
    if (!bucket) {
      bucket = await this.getBucketFromDataSet(manifest.dataSetId);
    }

    if (!bucket) {
      throw new Error('Bucket name is required. Either provide bucketName parameter or ensure dataset has a bucket configured.');
    }

    // Get dataset and project to find deployment endpoint and path prefix
    const dataSet = await dataSetRepo().findOne({ where: { id: manifest.dataSetId } });
    if (!dataSet) {
      throw new NotFoundError('DataSet', manifest.dataSetId);
    }
    const projectId = dataSet.projectId;

    // Resolve path prefix from project home_dir
    const projectEntity = await AppDataSource.getRepository(ProjectEntity).findOne({ where: { id: projectId } });
    const { pathPrefix } = getProjectStorageRoot(projectEntity!);

    // Get deployment endpoint for this bucket
    const deploymentEndpoint = await DeploymentEndpointService.getPrimaryDeploymentEndpoint(projectId, bucket);
    if (!deploymentEndpoint) {
      throw new Error(`No deployment endpoint found for bucket ${bucket} in project ${projectId}. Cannot generate presigned URLs.`);
    }

    const results: Array<{ id: string; preSignedUrl: string; fileName: string }> = [];

    for (const fileName of fileNames) {
      const fileId = uuidv4();
      const fileExtension = fileName.includes('.') ? fileName.substring(fileName.lastIndexOf('.')) : '';
      const uniqueFileName = `${fileId}${fileExtension}`;
      // Data files: <pathPrefix>/datasets/<dataset-id>/data_files/<filename>
      const key = `${pathPrefix}/datasets/${manifest.dataSetId}/data_files/${uniqueFileName}`;
      const uri = `s3://${bucket}/${key}`;

      // Create file record
      const fileRecord = fileRepo().create({
        manifestId: manifest.id,
        fileName,
        uri,
      });
      const savedFile = await fileRepo().save(fileRecord);

      // Generate pre-signed URL with deployment endpoint (requires S3 connection)
      try {
        const preSignedUrl = await generatePresignedUrl(bucket, key, 3600, deploymentEndpoint);
        results.push({
          id: savedFile.id,
          preSignedUrl,
          fileName,
        });
      } catch (error) {
        // If S3 connection fails, still save the file record but without pre-signed URL
        // The file can be uploaded directly to the URI
        throw new Error(`Failed to generate pre-signed URL for ${fileName}. S3 connection required. Error: ${error}`);
      }
    }

    return results;
  }

  /**
   * Replace all files in a draft manifest with a new set of URIs.
   * Deletes existing file records and creates new ones from the given URIs.
   * This is the "set files from URIs" operation used when the GUI sends the
   * full list of files (existing + new) as the source of truth.
   */
  static async replaceManifestFiles(manifestId: string, uris: string[]): Promise<DataSetManifest> {
    const manifest = await getManifestOrThrow(manifestId);
    validateDraftStatus(manifest, 'replace files in');

    // Validate uniqueness of new URIs
    if (uris.length > 0) {
      validateUniqueFileNames(uris);
    }

    // Enforce per-dataset file-count cap (exclude this manifest from the running total because
    // we're about to replace its file list).
    await this.enforceFileCountCap(manifest.dataSetId, uris.length, manifest.id);

    // Delete all existing file records for this manifest
    await fileRepo()
      .createQueryBuilder()
      .delete()
      .where('manifestId = :manifestId', { manifestId: manifest.id })
      .execute();

    // Create new file records from URIs
    if (uris.length > 0) {
      const fileRecords = uris.map((uri) => {
        const fileName = extractRelativePathFromUri(uri);
        return fileRepo().create({
          manifestId: manifest.id,
          fileName,
          uri,
        });
      });
      await fileRepo().save(fileRecords);
    }

    // Reload with relations
    return await this.getManifest(manifest.id) as DataSetManifest;
  }

  /**
   * Replace draft manifest file list from already-uploaded S3 URIs.
   * Does not go through DataSetService (no import auto-commit); use for chunked registration.
   */
  static async replaceDraftManifestSourceUris(
    manifestId: string,
    dataSetId: string,
    uris: string[]
  ): Promise<DataSetManifest> {
    const manifest = await getManifestOrThrow(manifestId);
    if (manifest.dataSetId !== dataSetId) {
      throw new NotFoundError('Manifest', manifestId);
    }
    return await this.replaceManifestFiles(manifestId, uris);
  }

  /**
   * Append already-uploaded S3 URIs to a draft manifest (chunked registration after first chunk).
   */
  static async appendDraftManifestSourceUris(
    manifestId: string,
    dataSetId: string,
    uris: string[]
  ): Promise<DataSetManifest> {
    if (uris.length === 0) {
      return (await this.getManifest(manifestId)) as DataSetManifest;
    }
    const manifest = await getManifestOrThrow(manifestId);
    if (manifest.dataSetId !== dataSetId) {
      throw new NotFoundError('Manifest', manifestId);
    }
    validateDraftStatus(manifest, 'append URIs to');
    validateUniqueFileNames(uris);
    const fileNames = uris.map((u) => extractRelativePathFromUri(u));
    await validateUniqueFileNamesInManifest(manifestId, fileNames);
    await this.enforceFileCountCap(manifest.dataSetId, uris.length);
    const fileRecords = uris.map((uri) =>
      fileRepo().create({
        manifestId: manifest.id,
        fileName: extractRelativePathFromUri(uri),
        uri,
      })
    );
    await fileRepo().save(fileRecords);
    return (await this.getManifest(manifest.id)) as DataSetManifest;
  }

  /**
   * Best-effort delete of the underlying storage objects for a set of manifest
   * file URIs (e.g. s3://bucket/key). Used when files are removed from a
   * dataset's manifest during an edit, so the removed files don't linger on
   * disk/S3 and get picked up again by the next import's directory scan.
   * Never throws — a failed cleanup should not block the manifest update.
   */
  static async deleteS3Objects(uris: string[]): Promise<void> {
    for (const uri of uris) {
      const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
      if (!match) {
        continue;
      }
      const [, bucket, key] = match;
      try {
        await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      } catch (error: any) {
        logger.warn(`[ManifestService] Failed to delete removed file from storage (s3://${bucket}/${key}):`, error?.message || error);
      }
    }
  }

  /**
   * Best-effort recursive delete of every object under an S3 prefix (e.g. a
   * table's Iceberg data directory such as `<pathPrefix>/datasets/<id>/parquet/`).
   * Lakekeeper's `purgeRequested` drop is expected to remove a managed table's
   * data files, but in deployments with soft-delete enabled that removal is
   * deferred/async, so a re-import triggered immediately after the drop can
   * still see the old files and fail with "tabular locations have to be
   * empty". Purging the location ourselves guarantees it's empty synchronously
   * before we re-trigger the import. Never throws.
   */
  static async deleteS3Prefix(bucket: string, prefix: string): Promise<void> {
    const normalizedPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
    let deletedCount = 0;
    try {
      let continuationToken: string | undefined;
      do {
        const page = await s3Client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: normalizedPrefix,
            ContinuationToken: continuationToken,
          }),
        );
        const keys = (page.Contents || []).map((obj) => obj.Key).filter((key): key is string => !!key);
        for (const key of keys) {
          try {
            await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
            deletedCount++;
          } catch (error: any) {
            logger.warn(`[ManifestService] Failed to delete object during prefix purge (s3://${bucket}/${key}):`, error?.message || error);
          }
        }
        continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (continuationToken);
      logger.info(`[ManifestService] Purged ${deletedCount} object(s) under s3://${bucket}/${normalizedPrefix}`);
    } catch (error: any) {
      logger.warn(`[ManifestService] Failed to list/purge objects under s3://${bucket}/${normalizedPrefix}:`, error?.message || error);
    }
  }

  /**
   * Delete a file from a manifest (only if status is draft)
   */
  static async deleteFileFromManifest(manifestId: string, fileId: string): Promise<void> {
    const manifest = await getManifestOrThrow(manifestId);
    validateDraftStatus(manifest, 'delete files from');

    const file = await fileRepo().findOne({
      where: { id: fileId, manifestId: manifest.id },
    });

    if (!file) {
      throw new Error(`File with id ${fileId} not found in manifest ${manifestId}`);
    }

    await fileRepo().remove(file);
  }

  /**
   * Get bucket name from dataset
   */
  private static async getBucketFromDataSet(dataSetId: string): Promise<string | null> {
    const dataSet = await dataSetRepo().findOne({ where: { id: dataSetId } });
    return dataSet?.bucketName || null;
  }


  /**
   * Write manifest file to S3 via the in-cluster S3 gateway (S3_ENDPOINT).
   * Browser uploads use the public deployment URL (presigned URLs); server-side
   * writes follow the same pattern as project init and import workers.
   */
  private static async writeManifestToS3(manifest: DataSetManifest): Promise<void> {
    // Get bucket from dataset (not from file URIs)
    const dataSet = await dataSetRepo().findOne({ where: { id: manifest.dataSetId } });
    if (!dataSet || !dataSet.bucketName) {
      logger.warn(`Cannot write manifest ${manifest.id} to S3: dataset ${manifest.dataSetId} has no bucket configured`);
      return;
    }

    const bucket = dataSet.bucketName;
    const projectId = dataSet.projectId;

    // Resolve path prefix from project home_dir
    const projectEntity = await AppDataSource.getRepository(ProjectEntity).findOne({ where: { id: projectId } });
    const { pathPrefix } = getProjectStorageRoot(projectEntity!);

    // Create manifest file content (JSON)
    const manifestContent = {
      id: manifest.id,
      dataSetId: manifest.dataSetId,
      manifestId: manifest.manifestId,
      status: manifest.status,
      metadata: manifest.metadata || {},
      schema: manifest.schema,
      files: manifest.files?.map(file => ({
        id: file.id,
        fileName: file.fileName,
        uri: file.uri,
        createdAt: file.createdAt.toISOString(),
      })) || [],
      createdAt: manifest.createdAt.toISOString(),
      updatedAt: manifest.updatedAt.toISOString(),
    };

    // Write to S3: s3://<bucket>/<pathPrefix>/datasets/<dataset_id>/manifests/v<version>.manifest
    const key = `${pathPrefix}/datasets/${manifest.dataSetId}/manifests/v${manifest.manifestId}.manifest`;
    const content = JSON.stringify(manifestContent, null, 2);

    try {
      await s3Client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: Buffer.from(content, 'utf-8'),
          ContentType: 'application/json',
        })
      );
    } catch (error: any) {
      logger.error(`Failed to write manifest file to S3 (${S3_CONFIG.S3_ENDPOINT}/${bucket}/${key}):`, error);

      // Surface connectivity failures as a warning on the dataset so the UI can display it
      const code = error?.code || error?.cause?.code;
      if (code === 'ETIMEDOUT' || code === 'ECONNREFUSED' || code === 'ECONNRESET') {
        try {
          const ds = await dataSetRepo().findOne({ where: { id: manifest.dataSetId } });
          if (ds && !ds.errorMessage) {
            ds.errorMessage = 'Storage gateway temporarily unreachable. Import will retry automatically.';
            await dataSetRepo().save(ds);
          }
        } catch (dbErr) {
          logger.warn('[ManifestService] Failed to set dataset warning:', dbErr);
        }
      }
    }
  }

  /**
   * Update manifest status
   * When committing a manifest:
   * 1. Writes manifest to S3
   * 2. Triggers dataset import workflow to process files and register with catalog
   */
  static async updateManifestStatus(manifestId: string, status: ManifestStatus): Promise<DataSetManifest> {
    const manifest = await getManifestOrThrow(manifestId);
    const previousStatus = manifest.status;
    manifest.status = status;
    await manifestRepo().save(manifest);

    // A dataset should only ever have one "live" committed manifest at a time.
    // Without this, every edit (which creates a new draft and commits it) leaves
    // the previously-committed manifest sitting around as 'committed' forever,
    // and countFiles()/file-count displays sum files across *every* committed
    // manifest ever created for the dataset — so the displayed file count keeps
    // growing on each edit instead of reflecting the current file set (even when
    // an edit only removes files). Deprecate any other committed manifest for
    // this dataset so only the one just committed remains 'committed'.
    if (status === 'committed' && previousStatus === 'draft') {
      await manifestRepo()
        .createQueryBuilder()
        .update(DataSetManifest)
        .set({ status: 'deprecated' })
        .where('"dataSetId" = :dataSetId', { dataSetId: manifest.dataSetId })
        .andWhere('id != :id', { id: manifest.id })
        .andWhere('status = :committed', { committed: 'committed' })
        .execute();
    }

    // Reload with files relation for S3 write
    const manifestWithFiles = await this.getManifest(manifest.id) as DataSetManifest;
    
    // When committing a manifest (draft -> committed):
    // 1. Write manifest file to S3
    // 2. Trigger dataset import workflow
    if (status === 'committed' && previousStatus === 'draft' && manifestWithFiles) {
      // Write manifest to S3
      await this.writeManifestToS3(manifestWithFiles);
      
      // Trigger dataset import workflow. Await so the commit response is not
      // followed by a detail refetch that still sees `ready` while the async
      // handler has not yet flipped the dataset to `in_progress`.
      try {
        await this.triggerDatasetImportWorkflow(manifestWithFiles.dataSetId);
      } catch (err) {
        logger.error(`[ManifestService] Failed to trigger import workflow for dataset ${manifestWithFiles.dataSetId}:`, err);
      }
    }
    
    return manifestWithFiles;
  }

  /**
   * Prepare a dataset that already has catalog data for a re-import: flip status
   * to in_progress and reset catalog/storage when required. Shared by manifest
   * commit and the direct POST /import route.
   */
  static async prepareDatasetReimport(
    dataSet: DataSet,
    bucketName: string,
    pathPrefix: string,
  ): Promise<void> {
    const namespace = dataSet.namespace || dataSet.projectId;
    const warehouseName = dataSet.warehouseName || 'nemo';
    const isManualUpload = dataSet.type === 'manual';
    const catalogTableName = dataSet.catalogTableName;
    const isReimport =
      (dataSet.status === 'ready' || dataSet.status === 'errored') && !!catalogTableName;
    if (!isReimport) {
      return;
    }

    const previousStatus = dataSet.status;
    dataSet.status = 'in_progress';
    dataSet.errorMessage = undefined;
    await dataSetRepo().save(dataSet);

    if (!isManualUpload) {
      try {
        await catalogService.deleteTable([namespace], catalogTableName!, warehouseName);
        logger.info(
          `[ManifestService] Dropped existing catalog table ${namespace}.${catalogTableName} before re-import for dataset ${dataSet.id}`,
        );
      } catch (error: any) {
        logger.warn(
          `[ManifestService] Failed to drop existing catalog table before re-import for dataset ${dataSet.id} (continuing anyway):`,
          error?.message || error,
        );
      }
      await ManifestService.deleteS3Prefix(bucketName, `${pathPrefix}/datasets/${dataSet.id}/parquet`);
    } else if (previousStatus === 'errored') {
      try {
        await catalogService.deleteTable([namespace], catalogTableName!, warehouseName);
        logger.info(
          `[ManifestService] Dropped broken catalog table ${namespace}.${catalogTableName} before manual recovery for dataset ${dataSet.id}`,
        );
      } catch (error: any) {
        logger.warn(
          `[ManifestService] Failed to drop broken catalog table for dataset ${dataSet.id} (continuing anyway):`,
          error?.message || error,
        );
      }
      await ManifestService.deleteS3Prefix(bucketName, `${pathPrefix}/datasets/${dataSet.id}/parquet`);
      await new Promise((resolve) => setTimeout(resolve, 8000));
    } else {
      logger.info(
        `[ManifestService] Manual re-import for dataset ${dataSet.id}: keeping catalog table ${namespace}.${catalogTableName} (worker will overwrite in place)`,
      );
    }
  }

  /**
   * Trigger the dataset import workflow
   * Called when a manifest is committed to process files and register with catalog
   */
  private static async triggerDatasetImportWorkflow(dataSetId: string): Promise<void> {
    try {
      // Get dataset details
      const dataSet = await dataSetRepo().findOne({ where: { id: dataSetId } });
      if (!dataSet) {
        logger.error(`[ManifestService] Dataset ${dataSetId} not found, cannot trigger import workflow`);
        return;
      }

      // Trigger (re-)import for any live dataset. This covers both the initial
      // import (status 'in_progress') and edits to an already-imported dataset
      // (status 'ready', e.g. a file was added/removed and the manifest was
      // re-committed) — otherwise edits silently never reach the catalog table.
      // Only a deprecated (deleted) dataset should never re-import.
      if (dataSet.status === 'deprecated') {
        logger.info(`[ManifestService] Dataset ${dataSetId} status is '${dataSet.status}', skipping import workflow`);
        return;
      }

      logger.info(`[ManifestService] Triggering import workflow for dataset: ${dataSetId} (${dataSet.kind})`);

      // Resolve bucket and pathPrefix from project home_dir
      const projectEntity = await AppDataSource.getRepository(ProjectEntity).findOne({ where: { id: dataSet.projectId } });
      const { bucketName, pathPrefix } = getProjectStorageRoot(projectEntity!);
      const namespace = dataSet.namespace || dataSet.projectId;
      // Pass warehouse NAME (not UUID) — Lakekeeper REST catalog expects the name.
      const warehouseName = dataSet.warehouseName || 'nemo';

      await ManifestService.prepareDatasetReimport(dataSet, bucketName, pathPrefix);

      // Import DatasetImportService dynamically to avoid circular dependencies
      const { DatasetImportService } = await import('./DatasetImportService');
      const importService = new DatasetImportService();

      const workflowId = await importService.startDatasetImport(
        dataSet.projectId,
        dataSetId,
        dataSet.name,
        dataSet.kind,
        bucketName,
        namespace,
        warehouseName,
        pathPrefix,
        dataSet.enablePiiAnalysis ?? false,
        dataSet.piiAnalysisImageOnly ?? false,
        undefined,
        dataSet.type,
      );

      if (workflowId) {
        // Update dataset with workflow ID
        dataSet.jobId = workflowId;
        await dataSetRepo().save(dataSet);
        logger.info(`[ManifestService] Import workflow started: ${workflowId}`);
      }
    } catch (error: any) {
      logger.error(`[ManifestService] Error triggering import workflow:`, error);
      // Don't throw - manifest commit should succeed even if workflow trigger fails
    }
  }

  /**
   * Update manifest metadata (draft only)
   */
  static async updateManifestMetadata(manifestId: string, metadata: Record<string, any>): Promise<DataSetManifest> {
    const manifest = await getManifestOrThrow(manifestId);
    validateDraftStatus(manifest, 'update metadata for');
    manifest.metadata = metadata;
    await manifestRepo().save(manifest);
    return await this.getManifest(manifest.id) as DataSetManifest;
  }

  /**
   * Update manifest schema (draft only)
   */
  static async updateManifestSchema(manifestId: string, schema?: Record<string, any>): Promise<DataSetManifest> {
    const manifest = await getManifestOrThrow(manifestId);
    validateDraftStatus(manifest, 'update schema for');
    manifest.schema = schema;
    await manifestRepo().save(manifest);
    return await this.getManifest(manifest.id) as DataSetManifest;
  }

  /**
   * List all manifests for a dataset
   */
  static async listManifests(dataSetId: string): Promise<DataSetManifest[]> {
    return await manifestRepo().find({
      where: { dataSetId },
      relations: ['files'],
      order: { manifestId: 'ASC' },
    });
  }

  /**
   * Delete all manifests for a dataset
   * This is used when a dataset is deleted to clean up all associated manifests
   * Note: Manifest files will be deleted automatically due to CASCADE in DataSetManifestFile entity
   */
  static async deleteAllManifestsForDataSet(dataSetId: string): Promise<void> {
    // Get all manifests for this dataset to get their IDs
    const manifests = await manifestRepo().find({
      where: { dataSetId },
      select: ['id'],
    });
    
    // Delete all manifest files first (explicit deletion for clarity)
    // Use query builder for bulk deletion with IN clause
    if (manifests.length > 0) {
      const manifestIds = manifests.map(m => m.id);
      await fileRepo()
        .createQueryBuilder()
        .delete()
        .where('manifestId IN (:...ids)', { ids: manifestIds })
        .execute();
    }
    
    // Delete all manifests for this dataset
    await manifestRepo().delete({ dataSetId });
  }

  /**
   * Get manifest by ID
   */
  static async getManifest(manifestId: string): Promise<DataSetManifest | null> {
    return await manifestRepo().findOne({
      where: { id: manifestId },
      relations: ['files'],
    });
  }

  /**
   * Get the latest manifest for a dataset (draft if exists, otherwise latest committed)
   */
  static async getLatestManifest(dataSetId: string): Promise<DataSetManifest | null> {
    // First check for draft
    const draft = await manifestRepo().findOne({
      where: { dataSetId, status: 'draft' },
      relations: ['files'],
      order: { manifestId: 'DESC' },
    });
    
    if (draft) {
      return draft;
    }
    
    // Otherwise get latest committed
    return await manifestRepo().findOne({
      where: { dataSetId, status: 'committed' },
      relations: ['files'],
      order: { manifestId: 'DESC' },
    });
  }

  /**
   * Create a new manifest from another manifest (copy/clone)
   */
  static async createManifestFromManifest(
    sourceManifestId: string,
    targetDataSetId?: string,
    metadata?: Record<string, any>,
    schema?: Record<string, any>
  ): Promise<DataSetManifest> {
    const sourceManifest = await this.getManifest(sourceManifestId);
    if (!sourceManifest) {
      throw new Error(`Source manifest with id ${sourceManifestId} not found`);
    }

    const finalDataSetId = targetDataSetId || sourceManifest.dataSetId;
    await verifyDataSetExists(finalDataSetId);
    await checkDraftManifestExists(finalDataSetId);

    // Validate that file names are unique if copying files
    if (sourceManifest.files && sourceManifest.files.length > 0) {
      const uris = sourceManifest.files.map(f => f.uri || '').filter(uri => uri);
      if (uris.length > 0) {
        validateUniqueFileNames(uris);
      }
    }

    const manifestId = await this.getNextManifestId(finalDataSetId);

    // Create new manifest
    // Use provided schema if given, otherwise copy from source manifest
    const finalSchema = schema !== undefined ? schema : sourceManifest.schema;
    const newManifest = manifestRepo().create({
      dataSetId: finalDataSetId,
      manifestId,
      status: 'draft',
      metadata: metadata || sourceManifest.metadata || {},
      schema: finalSchema,
    });
    const savedManifest = await manifestRepo().save(newManifest);

    // Copy file records
    // Files are already in S3, we just copy the URIs - no S3 connection needed
    if (sourceManifest.files && sourceManifest.files.length > 0) {
      const fileRecords = sourceManifest.files.map((file) =>
        fileRepo().create({
          manifestId: savedManifest.id,
          fileName: file.fileName || (file.uri ? extractRelativePathFromUri(file.uri) : 'unknown'),
          uri: file.uri,
        })
      );
      await fileRepo().save(fileRecords);
    }

    return await this.getManifest(savedManifest.id) as DataSetManifest;
  }
}
