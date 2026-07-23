package clients

import (
	"go.temporal.io/sdk/client"
)

// TemporalClient wraps Temporal client operations
type TemporalClient struct {
	client client.Client
}

func NewTemporalClient(address string) (*TemporalClient, error) {
	c, err := client.Dial(client.Options{
		HostPort: address,
	})
	if err != nil {
		return nil, err
	}

	return &TemporalClient{
		client: c,
	}, nil
}

// NewTemporalClientFromClient wraps an existing Temporal client (e.g. a mock)
// so callers like tests can construct a TemporalClient without dialing.
func NewTemporalClientFromClient(c client.Client) *TemporalClient {
	return &TemporalClient{client: c}
}

func (c *TemporalClient) GetClient() client.Client {
	return c.client
}

func (c *TemporalClient) Close() {
	if c.client != nil {
		c.client.Close()
	}
}
