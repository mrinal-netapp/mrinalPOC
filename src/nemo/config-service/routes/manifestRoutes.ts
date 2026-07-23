import 'reflect-metadata';
import { Router, Request } from 'express';
import { validationResult } from 'express-validator';
import { ManifestService } from '../services/ManifestService';
import {
  addFilesValidator,
  updateStatusValidator,
  updateMetadataValidator,
  updateSchemaValidator,
  replaceManifestSourceUrisValidator,
  appendManifestSourceUrisValidator,
} from '../validators/manifestValidator';
import { sendErrorResponse } from '../utils/errorHandler';

const router = Router({ mergeParams: true });

// Extend Request type to include dataset ID from parent route
interface ManifestRequest extends Request {
  params: {
    projectId: string;
    dataSetId: string;
    id?: string;
    fileId?: string;
    sourceManifestId?: string;
  };
}

/**
 * @swagger
 * /api/v1/namespaces/{projectId}/datasets/{dataSetId}/manifests:
 *   get:
 *     summary: List all manifests for a dataset
 *     tags: [Manifests]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: dataSetId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       '200':
 *         description: List of manifests
 */
router.get('/', async (req: ManifestRequest, res) => {
  try {
    const { dataSetId } = req.params;
    const manifests = await ManifestService.listManifests(dataSetId);
    res.json(manifests);
  } catch (error: any) {
    sendErrorResponse(res, error);
  }
});

/**
 * @swagger
 * /api/v1/namespaces/{projectId}/datasets/{dataSetId}/manifests:
 *   post:
 *     summary: Create a new manifest for a dataset
 *     tags: [Manifests]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: dataSetId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               uris:
 *                 type: array
 *                 items:
 *                   type: string
 *               metadata:
 *                 type: object
 *     responses:
 *       '201':
 *         description: Manifest created successfully
 *       '400':
 *         description: Bad request
 *       '404':
 *         description: Dataset not found
 *       '409':
 *         description: Draft manifest already exists
 */
router.post('/', async (req: ManifestRequest, res) => {
  try {
    const { dataSetId } = req.params;
    const { uris = [], metadata, schema } = req.body;
    const manifest = await ManifestService.createManifest(dataSetId, uris, metadata, schema);
    res.status(201).json(manifest);
  } catch (error: any) {
    sendErrorResponse(res, error);
  }
});

/**
 * @swagger
 * /api/v1/namespaces/{projectId}/datasets/{dataSetId}/manifests/from/{sourceManifestId}:
 *   post:
 *     summary: Create a new manifest from another manifest
 *     tags: [Manifests]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: dataSetId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: sourceManifestId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               targetDataSetId:
 *                 type: string
 *                 format: uuid
 *                 description: Target dataset ID (defaults to current dataset)
 *               metadata:
 *                 type: object
 *     responses:
 *       '201':
 *         description: Manifest created successfully
 *       '400':
 *         description: Bad request
 *       '404':
 *         description: Source manifest or dataset not found
 *       '409':
 *         description: Draft manifest already exists
 */
router.post('/from/:sourceManifestId', async (req: ManifestRequest, res) => {
  try {
    const { dataSetId, sourceManifestId } = req.params;
    if (!dataSetId || !sourceManifestId) {
      return res.status(400).json({ error: 'dataSetId and sourceManifestId are required' });
    }
    const { targetDataSetId, metadata, schema } = req.body;
    const finalDataSetId = targetDataSetId || dataSetId;
    const manifest = await ManifestService.createManifestFromManifest(
      sourceManifestId,
      finalDataSetId,
      metadata,
      schema
    );
    res.status(201).json(manifest);
  } catch (error: any) {
    sendErrorResponse(res, error);
  }
});

/**
 * Replace draft manifest file list from already-uploaded S3 URIs (chunk 0 of large manual uploads).
 * Bypasses dataset PUT so DataSetService does not auto-commit the manifest mid-registration.
 */
router.put(
  '/:id/source-uris',
  replaceManifestSourceUrisValidator,
  async (req: ManifestRequest, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array().map((e) => e.msg).join('; ') });
    }
    try {
      const { id, dataSetId } = req.params;
      if (!id || !dataSetId) {
        return res.status(400).json({ error: 'Manifest ID and dataset ID are required' });
      }
      const { uris } = req.body as { uris: string[] };
      const manifest = await ManifestService.replaceDraftManifestSourceUris(id, dataSetId, uris);
      res.json(manifest);
    } catch (error: any) {
      sendErrorResponse(res, error);
    }
  }
);

/**
 * Append already-uploaded S3 URIs to a draft manifest (subsequent chunks).
 */
router.post(
  '/:id/append-source-uris',
  appendManifestSourceUrisValidator,
  async (req: ManifestRequest, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array().map((e) => e.msg).join('; ') });
    }
    try {
      const { id, dataSetId } = req.params;
      if (!id || !dataSetId) {
        return res.status(400).json({ error: 'Manifest ID and dataset ID are required' });
      }
      const { uris } = req.body as { uris: string[] };
      const manifest = await ManifestService.appendDraftManifestSourceUris(id, dataSetId, uris);
      res.json(manifest);
    } catch (error: any) {
      sendErrorResponse(res, error);
    }
  }
);

/**
 * @swagger
 * /api/v1/namespaces/{projectId}/datasets/{dataSetId}/manifests/{id}:
 *   get:
 *     summary: Get manifest by ID
 *     tags: [Manifests]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: dataSetId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       '200':
 *         description: Manifest details
 *       '404':
 *         description: Manifest not found
 */
router.get('/:id', async (req: ManifestRequest, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: 'Manifest ID is required' });
    }
    const manifest = await ManifestService.getManifest(id);
    if (!manifest) {
      return res.status(404).json({ error: 'Manifest not found' });
    }
    res.json(manifest);
  } catch (error: any) {
    sendErrorResponse(res, error);
  }
});

/**
 * @swagger
 * /api/v1/namespaces/{projectId}/datasets/{dataSetId}/manifests/{id}/files:
 *   patch:
 *     summary: Add files to a manifest (draft only) - returns pre-signed URLs
 *     tags: [Manifests]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: dataSetId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [fileNames]
 *             properties:
 *               fileNames:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       '200':
 *         description: Returns array of file info with pre-signed URLs
 *       '400':
 *         description: Bad request or manifest not in draft status
 *       '404':
 *         description: Manifest not found
 */
router.patch('/:id/files', addFilesValidator, async (req: ManifestRequest, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: 'Manifest ID is required' });
    }
    const { fileNames } = req.body;
    const results = await ManifestService.addFilesToManifest(id, fileNames);
    res.json(results);
  } catch (error: any) {
    sendErrorResponse(res, error);
  }
});

/**
 * @swagger
 * /api/v1/namespaces/{projectId}/datasets/{dataSetId}/manifests/{id}/files/{fileId}:
 *   delete:
 *     summary: Delete a file from a manifest (draft only)
 *     tags: [Manifests]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: dataSetId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: fileId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       '200':
 *         description: File deleted successfully
 *       '400':
 *         description: Bad request or manifest not in draft status
 *       '404':
 *         description: Manifest or file not found
 */
router.delete('/:id/files/:fileId', async (req: ManifestRequest, res) => {
  try {
    const { id, fileId } = req.params;
    if (!id || !fileId) {
      return res.status(400).json({ error: 'Manifest ID and file ID are required' });
    }
    await ManifestService.deleteFileFromManifest(id, fileId);
    res.json({ deleted: true });
  } catch (error: any) {
    sendErrorResponse(res, error);
  }
});

/**
 * @swagger
 * /api/v1/namespaces/{projectId}/datasets/{dataSetId}/manifests/{id}/status:
 *   put:
 *     summary: Update manifest status
 *     tags: [Manifests]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: dataSetId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [draft, committed, deprecated]
 *     responses:
 *       '200':
 *         description: Status updated successfully
 *       '400':
 *         description: Bad request
 *       '404':
 *         description: Manifest not found
 */
router.put('/:id/status', updateStatusValidator, async (req: ManifestRequest, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: 'Manifest ID is required' });
    }
    const { status } = req.body;
    const manifest = await ManifestService.updateManifestStatus(id, status);
    res.json(manifest);
  } catch (error: any) {
    sendErrorResponse(res, error);
  }
});

/**
 * @swagger
 * /api/v1/namespaces/{projectId}/datasets/{dataSetId}/manifests/{id}/metadata:
 *   put:
 *     summary: Update manifest metadata (draft only)
 *     tags: [Manifests]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: dataSetId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [metadata]
 *             properties:
 *               metadata:
 *                 type: object
 *     responses:
 *       '200':
 *         description: Metadata updated successfully
 *       '400':
 *         description: Bad request or manifest not in draft status
 *       '404':
 *         description: Manifest not found
 */
router.put('/:id/metadata', updateMetadataValidator, async (req: ManifestRequest, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: 'Manifest ID is required' });
    }
    const { metadata } = req.body;
    const manifest = await ManifestService.updateManifestMetadata(id, metadata);
    res.json(manifest);
  } catch (error: any) {
    sendErrorResponse(res, error);
  }
});

/**
 * @swagger
 * /api/v1/namespaces/{projectId}/datasets/{dataSetId}/manifests/{id}/schema:
 *   put:
 *     summary: Update manifest schema (draft only)
 *     tags: [Manifests]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: dataSetId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               schema:
 *                 type: object
 *                 description: Optional schema definition for the manifest
 *     responses:
 *       '200':
 *         description: Schema updated successfully
 *       '400':
 *         description: Bad request or manifest not in draft status
 *       '404':
 *         description: Manifest not found
 */
router.put('/:id/schema', updateSchemaValidator, async (req: ManifestRequest, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: 'Manifest ID is required' });
    }
    const { schema } = req.body;
    const manifest = await ManifestService.updateManifestSchema(id, schema);
    res.json(manifest);
  } catch (error: any) {
    sendErrorResponse(res, error);
  }
});

export default router;
