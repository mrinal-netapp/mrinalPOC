import { KubernetesClientFactory } from '../KubernetesClientFactory';

const mockMakeApiClient = jest.fn().mockReturnValue({});
const mockLoadFromFile = jest.fn();
const mockLoadFromCluster = jest.fn();
const mockLoadFromDefault = jest.fn();
const mockGetCurrentContext = jest.fn().mockReturnValue('test-context');
const mockGetContextObject = jest.fn().mockReturnValue({ namespace: 'test-ns' });

jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: jest.fn().mockImplementation(() => ({
    loadFromFile: mockLoadFromFile,
    loadFromCluster: mockLoadFromCluster,
    loadFromDefault: mockLoadFromDefault,
    makeApiClient: mockMakeApiClient,
    getCurrentContext: mockGetCurrentContext,
    getContextObject: mockGetContextObject,
  })),
  StorageV1Api: class {},
  CoreV1Api: class {},
  AppsV1Api: class {},
  CustomObjectsApi: class {},
}));

// Mock fs so tests are deterministic regardless of whether the service-account
// namespace file exists in the environment (e.g. inside a Kubernetes pod in CI).
const mockExistsSync = jest.fn().mockReturnValue(false);
const mockReadFileSync = jest.fn();
jest.mock('fs', () => ({
  existsSync: (...args: any[]) => mockExistsSync(...args),
  readFileSync: (...args: any[]) => mockReadFileSync(...args),
}));

describe('KubernetesClientFactory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMakeApiClient.mockReturnValue({});
    mockGetCurrentContext.mockReturnValue('test-context');
    mockGetContextObject.mockReturnValue({ namespace: 'test-ns' });
    // Default: service-account namespace file does NOT exist
    mockExistsSync.mockReturnValue(false);
  });

  it('creates clients from a kubeconfig file when path is provided', () => {
    const clients = KubernetesClientFactory.createClients('/path/to/kubeconfig');

    expect(mockLoadFromFile).toHaveBeenCalledWith('/path/to/kubeconfig');
    expect(mockLoadFromCluster).not.toHaveBeenCalled();
    expect(clients.storageApi).toBeDefined();
    expect(clients.coreApi).toBeDefined();
    expect(clients.appsApi).toBeDefined();
    expect(clients.customObjectsApi).toBeDefined();
    expect(clients.namespace).toBe('test-ns');
  });

  it('falls back to loadFromDefault when loadFromCluster fails', () => {
    mockLoadFromCluster.mockImplementation(() => {
      throw new Error('not in cluster');
    });

    const clients = KubernetesClientFactory.createClients();

    expect(mockLoadFromCluster).toHaveBeenCalled();
    expect(mockLoadFromDefault).toHaveBeenCalled();
    expect(clients).toBeDefined();
  });

  it('uses loadFromCluster when no path is provided and cluster is available', () => {
    mockLoadFromCluster.mockImplementation(() => {});

    const clients = KubernetesClientFactory.createClients();

    expect(mockLoadFromCluster).toHaveBeenCalled();
    expect(mockLoadFromDefault).not.toHaveBeenCalled();
    expect(clients).toBeDefined();
  });

  it('returns "default" namespace when context has no namespace', () => {
    mockGetContextObject.mockReturnValue({ namespace: undefined });

    const clients = KubernetesClientFactory.createClients('/path/to/kubeconfig');

    expect(clients.namespace).toBe('default');
  });

  it('returns "default" namespace when context object is null', () => {
    mockGetContextObject.mockReturnValue(null);

    const clients = KubernetesClientFactory.createClients('/path/to/kubeconfig');

    expect(clients.namespace).toBe('default');
  });

  it('returns "default" namespace when getCurrentContext throws', () => {
    mockGetCurrentContext.mockImplementation(() => {
      throw new Error('no context');
    });

    const clients = KubernetesClientFactory.createClients('/path/to/kubeconfig');

    expect(clients.namespace).toBe('default');
  });

  it('reads namespace from service-account file when it exists in-cluster', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('in-cluster-namespace\n');

    const clients = KubernetesClientFactory.createClients('/path/to/kubeconfig');

    expect(mockExistsSync).toHaveBeenCalledWith(
      '/var/run/secrets/kubernetes.io/serviceaccount/namespace'
    );
    expect(clients.namespace).toBe('in-cluster-namespace');
  });

  it('falls back to kubeconfig namespace when service-account file exists but is empty', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('   ');

    const clients = KubernetesClientFactory.createClients('/path/to/kubeconfig');

    expect(clients.namespace).toBe('test-ns');
  });
});
