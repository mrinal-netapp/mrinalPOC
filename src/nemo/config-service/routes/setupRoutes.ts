import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import { Router, Request, Response } from 'express';
import { KeycloakClientService } from '../services/KeycloakClientService';

const router = Router();
const keycloakService = new KeycloakClientService();

// Neutral local-dev default for KEYCLOAK_ISSUER. Real deployments (AKS, helm
// installs) always set the env var, so this fallback only matters when running
// config-service directly without env config.
const DEFAULT_KEYCLOAK_ISSUER = 'http://localhost:18080/realms/nemo';

/**
 * GET /api/v1/setup/status
 * Returns setup status including whether setup is complete and admin credentials
 */
router.get('/status', async (req: Request, res: Response) => {
  try {
    // Check if realm exists
    const realmExists = await keycloakService.realmExists();
    
    if (!realmExists) {
      // Realm doesn't exist yet, setup is not complete
      const issuer = process.env.KEYCLOAK_ISSUER || DEFAULT_KEYCLOAK_ISSUER;
      const baseUrl = issuer.replace('/realms/nemo', '').replace('/realms/nemo/', '');
      const adminConsoleUrl = `${baseUrl}/admin`;
      const adminCredentials = keycloakService.getAdminCredentials();

      return res.status(200).json({
        isSetupComplete: false,
        adminConsoleUrl,
        adminCredentials: {
          username: adminCredentials.username,
          password: adminCredentials.password,
        },
        realmName: 'nemo',
        message: 'Keycloak realm does not exist yet. Please wait for the setup job to complete.',
      });
    }

    // Check user count (excluding service accounts)
    const userCount = await keycloakService.getUserCount();
    const isSetupComplete = userCount > 0;

    // Construct admin console URL from KEYCLOAK_ISSUER
    const issuer = process.env.KEYCLOAK_ISSUER || DEFAULT_KEYCLOAK_ISSUER;
    const baseUrl = issuer.replace('/realms/nemo', '').replace('/realms/nemo/', '');
    const adminConsoleUrl = `${baseUrl}/admin`;
    const adminCredentials = keycloakService.getAdminCredentials();

    res.status(200).json({
      isSetupComplete,
      adminConsoleUrl,
      adminCredentials: {
        username: adminCredentials.username,
        password: adminCredentials.password,
      },
      realmName: 'nemo',
      userCount,
    });
  } catch (error: any) {
    logger.error('[SetupRoutes] Error getting setup status:', error.message);
    
    // Return a safe response even if Keycloak is unavailable
    const issuer = process.env.KEYCLOAK_ISSUER || DEFAULT_KEYCLOAK_ISSUER;
    const baseUrl = issuer.replace('/realms/nemo', '').replace('/realms/nemo/', '');
    const adminConsoleUrl = `${baseUrl}/admin`;
    const adminCredentials = keycloakService.getAdminCredentials();

    res.status(200).json({
      isSetupComplete: false,
      adminConsoleUrl,
      adminCredentials: {
        username: adminCredentials.username,
        password: adminCredentials.password,
      },
      realmName: 'nemo',
      error: 'Unable to check setup status. Keycloak may be unavailable.',
      message: error.message,
    });
  }
});

export default router;
