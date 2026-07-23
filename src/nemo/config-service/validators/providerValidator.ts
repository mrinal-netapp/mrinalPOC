import { body } from 'express-validator';

/**
 * Validates the provider proxy-config edit (`PUT /projects/:projectId/
 * providers/:providerId`). Both fields are required positive integers — they
 * map to Bifrost's `concurrency_and_buffer_size` block, which rejects
 * zero/negative values, and the cache column is a non-nullable int.
 */
export const updateProviderProxyValidator = [
  body('concurrentRequests')
    .exists({ checkNull: true })
    .withMessage('concurrentRequests is required')
    .bail()
    .isInt({ min: 1 })
    .withMessage('concurrentRequests must be a positive integer'),
  body('bufferSize')
    .exists({ checkNull: true })
    .withMessage('bufferSize is required')
    .bail()
    .isInt({ min: 1 })
    .withMessage('bufferSize must be a positive integer'),
];
