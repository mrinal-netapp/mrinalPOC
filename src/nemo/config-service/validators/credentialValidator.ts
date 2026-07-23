import { body } from 'express-validator';

export const createCredentialValidator = [
  body('name').isString().notEmpty().withMessage('name is required'),
  body('provider').isString().notEmpty().withMessage('provider is required'),
  body('description').optional().isString(),
  body('metadata').optional().isObject(),
  body('labels').optional().isArray(),
  body('labels.*').optional().isString(),
  body('expiresAt').optional().isISO8601().withMessage('expiresAt must be an ISO date'),
  body('secretData').isObject().withMessage('secretData is required'),
];

export const updateCredentialValidator = [
  body('name').optional().isString(),
  body('description').optional().isString(),
  body('metadata').optional().isObject(),
  body('labels').optional().isArray(),
  body('labels.*').optional().isString(),
  body('expiresAt').optional().isISO8601().withMessage('expiresAt must be an ISO date'),
];

export const rotateCredentialValidator = [
  body('secretData').isObject().withMessage('secretData is required'),
  body('expiresAt').optional().isISO8601().withMessage('expiresAt must be an ISO date'),
];
