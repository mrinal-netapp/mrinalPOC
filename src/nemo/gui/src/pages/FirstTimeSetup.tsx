import { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  Button, 
  Text, 
  Card, 
  CardHeader,
  Spinner,
  Input,
  Field,
  MessageBar,
  MessageBarBody,
} from '@fluentui/react-components';
import { useSetupStatus } from '../hooks/useSetupStatus';
import { Copy24Regular, Open24Regular } from '@fluentui/react-icons';

const FirstTimeSetup = () => {
  const { 
    isLoading, 
    isSetupComplete, 
    adminConsoleUrl, 
    adminCredentials, 
    error,
    refetch 
  } = useSetupStatus();
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Auto-redirect if setup is complete
  useEffect(() => {
    // Only redirect if we're not already on the login page and not currently loading
    const currentPath = window.location.pathname;
    const basePath = import.meta.env.VITE_BASE_PATH || '';
    const normalizedPath = currentPath.replace(basePath, '') || '/';
    
    if (!isLoading && isSetupComplete && normalizedPath !== '/login' && normalizedPath !== '/login/') {
      navigate('/login', { replace: true });
    }
  }, [isLoading, isSetupComplete, navigate]);

  // Poll setup status every 5 seconds when on setup page
  // Only poll if we're actually on the setup page to prevent unnecessary requests
  useEffect(() => {
    const currentPath = window.location.pathname;
    const basePath = import.meta.env.VITE_BASE_PATH || '';
    const normalizedPath = currentPath.replace(basePath, '') || '/';
    const isOnSetupPage = normalizedPath === '/setup' || normalizedPath === '/setup/';
    
    // Clear any existing interval
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
    
    if (isOnSetupPage && !isSetupComplete && !isLoading) {
      const interval = setInterval(() => {
        refetch();
      }, 5000);
      pollingIntervalRef.current = interval;
      return () => {
        if (pollingIntervalRef.current) {
          clearInterval(pollingIntervalRef.current);
          pollingIntervalRef.current = null;
        }
      };
    }
  }, [isSetupComplete, isLoading, refetch]);

  const handleCopyPassword = async () => {
    if (adminCredentials?.password) {
      try {
        await navigator.clipboard.writeText(adminCredentials.password);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch (err) {
        console.error('Failed to copy password:', err);
      }
    }
  };

  const handleContinue = async () => {
    setIsChecking(true);
    await refetch();
    setIsChecking(false);
    
    // If setup is now complete, redirect will happen via useEffect
    if (!isSetupComplete) {
      // Show message that no users found
    }
  };

  const handleOpenAdminConsole = () => {
    if (adminConsoleUrl) {
      window.open(adminConsoleUrl, '_blank', 'noopener,noreferrer');
    }
  };

  if (isLoading) {
    return (
      <div style={{ 
        display: 'flex', 
        justifyContent: 'center', 
        alignItems: 'center', 
        minHeight: '100vh',
        flexDirection: 'column',
        gap: '1rem'
      }}>
        <Spinner label="Checking setup status..." size="large" />
      </div>
    );
  }

  if (isSetupComplete) {
    return (
      <div style={{ 
        display: 'flex', 
        justifyContent: 'center', 
        alignItems: 'center', 
        minHeight: '100vh',
        flexDirection: 'column',
        gap: '1rem'
      }}>
        <Spinner label="Setup complete! Redirecting..." size="large" />
      </div>
    );
  }

  return (
    <div style={{
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      minHeight: '100vh',
      padding: '2rem',
      backgroundColor: '#f5f5f5'
    }}>
      <Card style={{ maxWidth: '600px', width: '100%' }}>
        <CardHeader
          header={
            <Text as="h1" size={700} weight="semibold">
              Welcome to AgentStudio
            </Text>
          }
          description={
            <Text>
              Let's get you started! First, you'll need to create a user account in Keycloak.
            </Text>
          }
        />
        <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {error && (
            <MessageBar intent="warning">
              <MessageBarBody>
                {error}
              </MessageBarBody>
            </MessageBar>
          )}

          <div>
            <Text as="h2" size={500} weight="semibold" style={{ marginBottom: '1rem' }}>
              Step 1: Access Keycloak Admin Console
            </Text>
            <Text style={{ marginBottom: '1rem', display: 'block' }}>
              Click the button below to open the Keycloak Admin Console in a new tab.
            </Text>
            <Button
              appearance="primary"
              icon={<Open24Regular />}
              onClick={handleOpenAdminConsole}
              disabled={!adminConsoleUrl}
              style={{ width: '100%' }}
            >
              Open Keycloak Admin Console
            </Button>
            {adminConsoleUrl && (
              <Text size={200} style={{ marginTop: '0.5rem', color: '#666' }}>
                URL: {adminConsoleUrl}
              </Text>
            )}
          </div>

          <div>
            <Text as="h2" size={500} weight="semibold" style={{ marginBottom: '1rem' }}>
              Step 2: Login with Admin Credentials
            </Text>
            <Text style={{ marginBottom: '1rem', display: 'block' }}>
              Use the following credentials to login to Keycloak:
            </Text>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <Field label="Username" size="large">
                <Input
                  value={adminCredentials?.username || ''}
                  readOnly
                  style={{ fontFamily: 'monospace' }}
                />
              </Field>
              <Field 
                label="Password" 
                size="large"
                hint="Click the copy button to copy the password"
              >
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <Input
                    type="password"
                    value={adminCredentials?.password || ''}
                    readOnly
                    style={{ fontFamily: 'monospace', flex: 1 }}
                  />
                  <Button
                    appearance="secondary"
                    icon={<Copy24Regular />}
                    onClick={handleCopyPassword}
                    title="Copy password"
                  >
                    {copied ? 'Copied!' : 'Copy'}
                  </Button>
                </div>
              </Field>
            </div>
          </div>

          <div>
            <Text as="h2" size={500} weight="semibold" style={{ marginBottom: '1rem' }}>
              Step 3: Create Your First User
            </Text>
            <div style={{ 
              backgroundColor: '#f9f9f9', 
              padding: '1rem', 
              borderRadius: '4px',
              marginBottom: '1rem'
            }}>
              <Text style={{ display: 'block', marginBottom: '0.5rem' }}>
                In the Keycloak Admin Console:
              </Text>
              <ol style={{ margin: 0, paddingLeft: '1.5rem' }}>
                <li>Select the <strong>"Nemo"</strong> realm from the realm dropdown (top left)</li>
                <li>Navigate to <strong>Users</strong> in the left sidebar</li>
                <li>Click <strong>"Add user"</strong> button</li>
                <li>Fill in the required fields (Username, Email, First Name, Last Name)</li>
                <li>Click <strong>"Create"</strong></li>
                <li>Go to the <strong>"Credentials"</strong> tab and set a password</li>
                <li>Click <strong>"Set password"</strong> and confirm</li>
              </ol>
            </div>
          </div>

          <div>
            <Text as="h2" size={500} weight="semibold" style={{ marginBottom: '1rem' }}>
              Step 4: Continue
            </Text>
            <Text style={{ marginBottom: '1rem', display: 'block' }}>
              Once you've created your first user, click the button below to continue.
              We'll automatically detect when a user has been created.
            </Text>
            <Button
              appearance="primary"
              size="large"
              onClick={handleContinue}
              disabled={isChecking}
              style={{ width: '100%' }}
            >
              {isChecking ? (
                <>
                  <Spinner size="tiny" style={{ marginRight: '0.5rem' }} />
                  Checking...
                </>
              ) : (
                'Continue'
              )}
            </Button>
          </div>

          <div style={{ 
            marginTop: '1rem', 
            paddingTop: '1rem', 
            borderTop: '1px solid #e0e0e0' 
          }}>
            <Text size={200} style={{ color: '#666' }}>
              <strong>Note:</strong> This setup page will automatically redirect you to the login page 
              once a user is detected in Keycloak. You can also manually refresh this page.
            </Text>
          </div>
        </div>
      </Card>
    </div>
  );
};

export default FirstTimeSetup;
