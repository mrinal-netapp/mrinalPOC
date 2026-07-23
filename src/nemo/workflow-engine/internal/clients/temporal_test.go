package clients

import (
	"net"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/mocks"
)

func TestNewTemporalClient_DialErrorPropagated(t *testing.T) {
	// Reserve an ephemeral local port and close it immediately so the dial
	// is guaranteed to hit "connection refused" -- avoids the brittleness
	// of assuming a hard-coded port (e.g. 127.0.0.1:1) is free on every
	// developer machine / CI runner.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	addr := ln.Addr().String()
	require.NoError(t, ln.Close())

	_, err = NewTemporalClient(addr)
	require.Error(t, err, "no Temporal at %s — dial must fail", addr)
}

func TestNewTemporalClientFromClient_GetClientAndClose(t *testing.T) {
	mt := &mocks.Client{}
	mt.On("Close").Once()

	tc := NewTemporalClientFromClient(mt)
	require.NotNil(t, tc)
	assert.Same(t, mt, tc.GetClient())

	tc.Close()
	mt.AssertExpectations(t)
}

func TestTemporalClient_Close_SafeWhenNil(t *testing.T) {
	tc := &TemporalClient{}
	tc.Close() // must not panic
}
