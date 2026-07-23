package services

import "testing"

// TestResolveConnectorTestActivityName pins down the routing so a "storage"
// connector (NetApp ONTAP) is never accidentally tested with a database-shaped
// activity. Each case is the (connector_type, provider) pair the GUI / DB
// would emit for a given connector.
func TestResolveConnectorTestActivityName(t *testing.T) {
	cases := []struct {
		name     string
		connType string
		provider string
		want     string
	}{
		{"ontap storage routes to generic provider activity", "storage", "ontap", "TestProviderConnection"},
		{"objectstore (s3) routes to object-store activity", "objectstore", "s3", "TestObjectStoreConnection"},
		{"cloud (gcp) routes to cloud activity", "cloud", "gcp", "TestCloudConnection"},
		{"cloud (azure_cloud) routes to generic provider activity", "cloud", "azure_cloud", "TestProviderConnection"},
		{"database (postgresql) routes to database activity", "database", "postgresql", "TestDatabaseConnection"},
		{"database (mysql) routes to database activity", "database", "mysql", "TestDatabaseConnection"},

		// Defensive fallbacks for legacy DB rows lacking connector_type.
		// Only the ontap provider keeps an explicit legacy fallback (see
		// resolveConnectorTestActivityName). For every other legacy row the
		// resolver now returns "" so the caller surfaces an
		// "unsupported connector type" error instead of silently routing to
		// the database activity. This is a deliberate hardening — the
		// previous "default to TestDatabaseConnection" behaviour was the bug
		// the connector_type-first routing was introduced to prevent.
		{"legacy ontap with no connector_type still routes to provider activity", "", "ontap", "TestProviderConnection"},
		{"legacy db with no connector_type no longer auto-routes to database", "", "postgresql", ""},
		{"empty everything no longer auto-routes to database", "", "", ""},

		// Future-proofing: an unknown connector_type must NOT be treated as
		// a database test — a storage backend with provider=ontap should
		// still land on the generic activity even if the type label changes.
		{"unknown connector_type with ontap provider uses generic activity", "weird", "ontap", "TestProviderConnection"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := resolveConnectorTestActivityName(tc.connType, tc.provider)
			if got != tc.want {
				t.Fatalf("resolveConnectorTestActivityName(%q, %q) = %q, want %q",
					tc.connType, tc.provider, got, tc.want)
			}
		})
	}
}
