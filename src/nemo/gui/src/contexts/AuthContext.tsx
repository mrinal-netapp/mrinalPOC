import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react'
import { UserManager, User, UserManagerSettings } from 'oidc-client-ts'

export interface AuthUser {
  id: string
  email?: string
  username?: string
  name?: string
  projectId?: string
  namespaceId?: string
}

interface AuthContextType {
  user: AuthUser | null
  isLoading: boolean
  isAuthenticated: boolean
  login: () => Promise<void>
  logout: () => Promise<void>
  getAccessToken: () => string | null
  refreshToken: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

// Get Keycloak configuration from environment variables
const getKeycloakConfig = (): UserManagerSettings => {
  // Keycloak issuer resolution order:
  //   1. window.__RUNTIME_CONFIG__.keycloakIssuer  (deploy-time, injected by GUI entrypoint from KEYCLOAK_ISSUER env)
  //   2. import.meta.env.VITE_KEYCLOAK_ISSUER       (build-time, baked into JS bundle)
  //   3. fallback constant
  // Runtime takes precedence so the same image works across ENDPOINTs without rebuild.
  const runtimeConfig = (window as any).__RUNTIME_CONFIG__ as { keycloakIssuer?: string } | undefined
  const runtimeIssuer = runtimeConfig?.keycloakIssuer
  const issuer =
    (runtimeIssuer && runtimeIssuer.length > 0 ? runtimeIssuer : null) ||
    import.meta.env.VITE_KEYCLOAK_ISSUER ||
    'https://auth.agentstudio.io/realms/agentstudio'
  const clientId = import.meta.env.VITE_KEYCLOAK_CLIENT_ID || 'agentstudio-gui'
  const basePath = import.meta.env.VITE_BASE_PATH || '/'
  
  // Construct redirect URI based on base path
  const redirectUri = `${window.location.origin}${basePath}/auth/callback`
  const postLogoutRedirectUri = `${window.location.origin}${basePath}`

  // Extract authority from issuer, ensuring it includes the port from origin if present
  // The issuer might be like "https://auth.agentstudio.local/realms/agentstudio"
  // For Keycloak, the authority is the base URL without /realms/{realm}
  // We need to extract the base URL from the issuer
  let authority = issuer
  // Remove /realms/{realm} suffix if present to get base authority
  const realmsMatch = issuer.match(/^(https?:\/\/[^\/]+)(\/realms\/[^\/]+)?/)
  if (realmsMatch && realmsMatch[1]) {
    authority = realmsMatch[1]
  }
  
  // If the origin has a port, ensure the authority also has the same port
  // This is important for local dev where we use non-standard ports (e.g., 8443)
  const originUrl = new URL(window.location.origin)
  if (originUrl.port) {
    const authorityUrl = new URL(authority)
    // Always use the same port as the origin if origin has a port
    // This ensures consistency (e.g., if accessing via 8443, auth should also use 8443)
    authority = `${authorityUrl.protocol}//${authorityUrl.hostname}:${originUrl.port}`
  }

  // Build issuer with port if origin has a port (for metadata endpoints)
  // The issuer should match the authority but include /realms/{realm}
  let issuerWithPort = issuer
  if (originUrl.port) {
    const issuerUrl = new URL(issuer)
    // Extract realm path if present (e.g., /realms/agentstudio)
    const realmPath = issuerUrl.pathname
    // Build issuer with port: protocol + hostname + port + realm path
    issuerWithPort = `${issuerUrl.protocol}//${issuerUrl.hostname}:${originUrl.port}${realmPath}`
  }

  return {
    authority: authority,
    client_id: clientId,
    redirect_uri: redirectUri,
    post_logout_redirect_uri: postLogoutRedirectUri,
    response_type: 'code',
    scope: 'openid profile email',
    automaticSilentRenew: true,
    silent_redirect_uri: `${window.location.origin}${basePath}/auth/silent-callback`,
    loadUserInfo: true,
    metadata: {
      issuer: issuerWithPort,  // Use issuer with port for all metadata endpoints
      authorization_endpoint: `${issuerWithPort}/protocol/openid-connect/auth`,
      token_endpoint: `${issuerWithPort}/protocol/openid-connect/token`,
      userinfo_endpoint: `${issuerWithPort}/protocol/openid-connect/userinfo`,
      end_session_endpoint: `${issuerWithPort}/protocol/openid-connect/logout`,
      jwks_uri: `${issuerWithPort}/protocol/openid-connect/certs`,
    },
  }
}

let userManager: UserManager | null = null

const getUserManager = (): UserManager => {
  if (!userManager) {
    userManager = new UserManager(getKeycloakConfig())
  }
  return userManager
}

export const useAuth = () => {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider')
  }
  return context
}

const mapOidcUserToAuthUser = (oidcUser: User | null): AuthUser | null => {
  if (!oidcUser) return null

  return {
    id: oidcUser.profile.sub || '',
    email: oidcUser.profile.email,
    username: oidcUser.profile.preferred_username || oidcUser.profile.name,
    name: oidcUser.profile.name,
    projectId: (oidcUser.profile as any)['agentstudio.project_id'],
    namespaceId: (oidcUser.profile as any)['agentstudio.namespace_id'],
  }
}

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [accessToken, setAccessToken] = useState<string | null>(null)

  const manager = getUserManager()

  const refreshToken = useCallback(async () => {
    try {
      const oidcUser = await manager.signinSilent()
      const authUser = mapOidcUserToAuthUser(oidcUser)
      setUser(authUser)
      setAccessToken(oidcUser?.access_token || null)
      setIsAuthenticated(true)
    } catch (error) {
      console.error('Token refresh failed:', error)
      // Clear stale/invalid session from storage to prevent redirect loops
      // (getUser() would otherwise keep returning the invalid user)
      try {
        await manager.removeUser()
      } catch (removeErr) {
        // Ignore removeUser errors (e.g. if no user in storage)
      }
      setUser(null)
      setAccessToken(null)
      setIsAuthenticated(false)
      throw error
    }
  }, [manager])

  // Load user on mount
  useEffect(() => {
    const loadUser = async () => {
      try {
        const oidcUser = await manager.getUser()
        const authUser = mapOidcUserToAuthUser(oidcUser)
        setUser(authUser)
        setAccessToken(oidcUser?.access_token || null)
        setIsAuthenticated(!!authUser)
      } catch (error) {
        console.error('Failed to load user:', error)
        try {
          await manager.removeUser()
        } catch (removeErr) {
          // Ignore
        }
        setUser(null)
        setAccessToken(null)
        setIsAuthenticated(false)
      } finally {
        setIsLoading(false)
      }
    }

    loadUser()

    // Define event handlers
    const handleUserLoaded = (loadedUser: any) => {
      const authUser = mapOidcUserToAuthUser(loadedUser)
      setUser(authUser)
      setAccessToken(loadedUser?.access_token || null)
      setIsAuthenticated(true)
      setIsLoading(false)
    }

    const handleUserUnloaded = () => {
      setUser(null)
      setAccessToken(null)
      setIsAuthenticated(false)
    }

    const handleAccessTokenExpiring = () => {
      // Token is expiring, will be automatically renewed by automaticSilentRenew
      console.log('Access token expiring, will renew automatically')
    }

    const handleAccessTokenExpired = () => {
      // Token expired, try to renew (refreshToken() clears storage on failure)
      refreshToken().catch((error) => {
        console.error('Failed to refresh token:', error)
      })
    }

    // Register event handlers
    manager.events.addUserLoaded(handleUserLoaded)
    manager.events.addUserUnloaded(handleUserUnloaded)
    manager.events.addAccessTokenExpiring(handleAccessTokenExpiring)
    manager.events.addAccessTokenExpired(handleAccessTokenExpired)

    // Cleanup: remove event handlers
    return () => {
      manager.events.removeUserLoaded(handleUserLoaded)
      manager.events.removeUserUnloaded(handleUserUnloaded)
      manager.events.removeAccessTokenExpiring(handleAccessTokenExpiring)
      manager.events.removeAccessTokenExpired(handleAccessTokenExpired)
    }
  }, [manager, refreshToken])

  const login = useCallback(async () => {
    try {
      await manager.signinRedirect()
    } catch (error) {
      console.error('Login failed:', error)
      throw error
    }
  }, [manager])

  const logout = useCallback(async () => {
    try {
      await manager.signoutRedirect()
      setUser(null)
      setAccessToken(null)
      setIsAuthenticated(false)
    } catch (error) {
      console.error('Logout failed:', error)
      throw error
    }
  }, [manager])

  const getAccessToken = useCallback((): string | null => {
    return accessToken
  }, [accessToken])

  const value: AuthContextType = {
    user,
    isLoading,
    isAuthenticated,
    login,
    logout,
    getAccessToken,
    refreshToken,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// Export function to handle OIDC callback
export const handleAuthCallback = async (): Promise<void> => {
  const manager = getUserManager()
  try {
    await manager.signinRedirectCallback()
    // Redirect to home after successful login
    window.location.href = import.meta.env.VITE_BASE_PATH || '/'
  } catch (error) {
    console.error('Auth callback failed:', error)
    throw error
  }
}

// Export function to handle silent callback
export const handleSilentCallback = async (): Promise<void> => {
  const manager = getUserManager()
  try {
    await manager.signinSilentCallback()
  } catch (error) {
    console.error('Silent callback failed:', error)
    throw error
  }
}
