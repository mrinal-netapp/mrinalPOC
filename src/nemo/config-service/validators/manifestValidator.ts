import { body } from 'express-validator';

export const addFilesValidator = [
  body('fileNames').isArray().notEmpty().withMessage('fileNames must be a non-empty array'),
  body('fileNames.*').isString().notEmpty().withMessage('Each fileName must be a non-empty string'),
];

export const updateStatusValidator = [
  body('status')
    .isString()
    .isIn(['draft', 'committed', 'deprecated'])
    .withMessage('status must be one of: draft, committed, deprecated'),
];

export const updateMetadataValidator = [
  body('metadata')
    .isObject()
    .withMessage('metadata must be an object'),
];

export const updateSchemaValidator = [
  body('schema')
    .optional()
    .isObject()
    .withMessage('schema must be an object'),
];

/** Replace draft manifest file list from already-uploaded S3 URIs (GUI chunking / large uploads). */
export const replaceManifestSourceUrisValidator = [
  body('uris').isArray().withMessage('uris must be an array'),
  body('uris').custom((uris: unknown) => {
    if (!Array.isArray(uris) || uris.length > 2000) {
      throw new Error('uris must be an array with at most 2000 entries per request');
    }
    return true;
  }),
  body('uris.*').optional().isString().isLength({ min: 1, max: 4096 }),
];

/** Append already-uploaded S3 URIs to a draft manifest (GUI chunking). */
export const appendManifestSourceUrisValidator = [
  body('uris').isArray().notEmpty().withMessage('uris must be a non-empty array'),
  body('uris').custom((uris: unknown) => {
    if (!Array.isArray(uris) || uris.length > 2000) {
      throw new Error('uris must have 1–2000 entries per request');
    }
    return true;
  }),
  body('uris.*').isString().isLength({ min: 1, max: 4096 }),
];

