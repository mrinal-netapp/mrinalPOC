import { useState, useEffect } from 'react';
import { configServiceApi } from '../services/api';

export interface SetupStatus {
  isSetupComplete: boolean;
  adminConsoleUrl: string;
  adminCredentials: {
    username: string;
    password: string;
  };
  realmName: string;
  userCount?: number;
  error?: string;
  message?: string;
}

interface UseSetupStatusReturn {
  isLoading: boolean;
  isSetupComplete: boolean;
  adminConsoleUrl: string | null;
  adminCredentials: { username: string; password: string } | null;
  realmName: string | null;
  error: string | null;
  refetch: () => Promise<void>;
}

/**
 * Hook to fetch and manage setup status from config-service
 * This checks if Keycloak realm has users and returns admin credentials
 */
export function useSetupStatus(): UseSetupStatusReturn {
  const [isLoading, setIsLoading] = useState(true);
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchSetupStatus = async () => {
    try {
      setIsLoading(true);
      setError(null);
      // Use configServiceApi which correctly handles /config prefix when behind gateway
      // The baseURL is /config, and we need /api/v1/setup/status
      // This is a public endpoint - the request interceptor will skip adding auth headers
      const response = await configServiceApi.get<SetupStatus>('/api/v1/setup/status');
      setSetupStatus(response.data);
    } catch (err: any) {
      console.error('[useSetupStatus] Failed to fetch setup status:', err);
      // For 401 errors on public endpoints, treat as setup not complete
      // This prevents redirect loops when the endpoint is accessible but returns 401
      if (err.response?.status === 401) {
        console.warn('[useSetupStatus] Got 401 on public endpoint, treating as setup incomplete');
        setSetupStatus({
          isSetupComplete: false,
          adminConsoleUrl: '',
          adminCredentials: {
            username: 'admin',
            password: 'AgentStudioAdmin123!',
          },
          realmName: 'agentstudio',
          error: 'Unable to check setup status. Please ensure Keycloak is running.',
        });
      } else {
        setError(err.response?.data?.message || err.message || 'Failed to fetch setup status');
        // Set default values on error
        setSetupStatus({
          isSetupComplete: false,
          adminConsoleUrl: '',
          adminCredentials: {
            username: 'admin',
            password: 'AgentStudioAdmin123!',
          },
          realmName: 'agentstudio',
          error: err.message,
        });
      }
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchSetupStatus();
  }, []);

  return {
    isLoading,
    isSetupComplete: setupStatus?.isSetupComplete ?? false,
    adminConsoleUrl: setupStatus?.adminConsoleUrl ?? null,
    adminCredentials: setupStatus?.adminCredentials ?? null,
    realmName: setupStatus?.realmName ?? null,
    error: error || setupStatus?.error || null,
    refetch: fetchSetupStatus,
  };
}
