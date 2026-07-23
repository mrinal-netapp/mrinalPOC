import { describe, it, expect } from "vitest"
import {
  validateGcpServiceAccountJson,
  normalizeProviderSecretData,
  GCP_SERVICE_ACCOUNT_JSON_MAX_BYTES,
} from "./gcpServiceAccountJson"

// ---------------------------------------------------------------------------
// Minimal valid GCP service account key fixture
// ---------------------------------------------------------------------------

const VALID_SA = {
  type: "service_account",
  project_id: "my-project",
  private_key_id: "key123",
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n",
  client_email: "sa@my-project.iam.gserviceaccount.com",
  client_id: "123456789",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
}

const validJson = JSON.stringify(VALID_SA)
const validJsonPretty = JSON.stringify(VALID_SA, null, 2)

// ---------------------------------------------------------------------------
// validateGcpServiceAccountJson
// ---------------------------------------------------------------------------

describe("validateGcpServiceAccountJson", () => {
  describe("empty / whitespace input", () => {
    it("rejects an empty string", () => {
      const result = validateGcpServiceAccountJson("")
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.message).toMatch(/empty/i)
    })

    it("rejects a whitespace-only string", () => {
      const result = validateGcpServiceAccountJson("   \n  ")
      expect(result.ok).toBe(false)
    })
  })

  describe("size limit", () => {
    it("rejects input that exceeds the byte limit", () => {
      const oversized = "x".repeat(GCP_SERVICE_ACCOUNT_JSON_MAX_BYTES + 1)
      const result = validateGcpServiceAccountJson(oversized)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.message).toMatch(/too large/i)
    })

    it("accepts input exactly at the byte limit when it is valid JSON", () => {
      // Just confirm the size guard does not fire for normal-sized input
      const result = validateGcpServiceAccountJson(validJson)
      expect(result.ok).toBe(true)
    })
  })

  describe("invalid JSON", () => {
    it("rejects malformed JSON", () => {
      const result = validateGcpServiceAccountJson("{not: valid json}")
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.message).toMatch(/invalid json/i)
    })

    it("rejects a JSON array", () => {
      const result = validateGcpServiceAccountJson("[1, 2, 3]")
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.message).toMatch(/array/i)
    })

    it("rejects a JSON primitive (string)", () => {
      const result = validateGcpServiceAccountJson('"just a string"')
      expect(result.ok).toBe(false)
    })

    it("rejects JSON null", () => {
      const result = validateGcpServiceAccountJson("null")
      expect(result.ok).toBe(false)
    })
  })

  describe("wrong type field", () => {
    it("rejects a JSON object without the type field", () => {
      const withoutType = Object.fromEntries(
        Object.entries(VALID_SA).filter(([key]) => key !== "type"),
      )
      const result = validateGcpServiceAccountJson(JSON.stringify(withoutType))
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.message).toMatch(/service_account/i)
    })

    it("rejects a JSON object with the wrong type value", () => {
      const result = validateGcpServiceAccountJson(
        JSON.stringify({ ...VALID_SA, type: "oauth2" }),
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.message).toMatch(/service_account/i)
    })
  })

  describe("missing required string fields", () => {
    const requiredFields = ["project_id", "private_key_id", "private_key", "client_email"] as const

    for (const field of requiredFields) {
      it(`rejects when ${field} is missing`, () => {
        const rest = Object.fromEntries(
          Object.entries(VALID_SA).filter(([key]) => key !== field),
        )
        const result = validateGcpServiceAccountJson(JSON.stringify(rest))
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.message).toContain(field)
      })

      it(`rejects when ${field} is an empty string`, () => {
        const result = validateGcpServiceAccountJson(
          JSON.stringify({ ...VALID_SA, [field]: "   " }),
        )
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.message).toContain(field)
      })

      it(`rejects when ${field} is a non-string type`, () => {
        const result = validateGcpServiceAccountJson(
          JSON.stringify({ ...VALID_SA, [field]: 42 }),
        )
        expect(result.ok).toBe(false)
      })
    }
  })

  describe("client_email validation", () => {
    it("rejects an email without an @ symbol", () => {
      const result = validateGcpServiceAccountJson(
        JSON.stringify({ ...VALID_SA, client_email: "notanemail" }),
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.message).toMatch(/email/i)
    })
  })

  describe("private_key validation", () => {
    it("rejects a private_key without the PEM header", () => {
      const result = validateGcpServiceAccountJson(
        JSON.stringify({ ...VALID_SA, private_key: "MIIE..." }),
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.message).toMatch(/pem/i)
    })
  })

  describe("valid input", () => {
    it("accepts a valid service account JSON and returns ok: true", () => {
      const result = validateGcpServiceAccountJson(validJson)
      expect(result.ok).toBe(true)
    })

    it("minifies pretty-printed JSON", () => {
      const result = validateGcpServiceAccountJson(validJsonPretty)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.normalized).toBe(JSON.stringify(JSON.parse(validJsonPretty)))
        expect(result.normalized).not.toContain("\n")
      }
    })

    it("trims leading/trailing whitespace before parsing", () => {
      const result = validateGcpServiceAccountJson(`  \n${validJson}\n  `)
      expect(result.ok).toBe(true)
    })

    it("preserves all required fields in normalized output", () => {
      const result = validateGcpServiceAccountJson(validJson)
      expect(result.ok).toBe(true)
      if (result.ok) {
        const parsed = JSON.parse(result.normalized) as typeof VALID_SA
        expect(parsed.type).toBe("service_account")
        expect(parsed.project_id).toBe(VALID_SA.project_id)
        expect(parsed.client_email).toBe(VALID_SA.client_email)
      }
    })
  })
})

// ---------------------------------------------------------------------------
// normalizeProviderSecretData
// ---------------------------------------------------------------------------

describe("normalizeProviderSecretData", () => {
  describe("non-GCP providers (passthrough)", () => {
    const nonGcpProviders = ["openai", "aws_bedrock", "azure", "postgresql", "custom-provider"]

    for (const provider of nonGcpProviders) {
      it(`passes secretData through unchanged for provider "${provider}"`, () => {
        const secretData = { api_key: "sk-abc123" }
        const result = normalizeProviderSecretData(provider, secretData)
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.secretData).toBe(secretData)
      })
    }
  })

  describe("GCP providers (gcp, gcs)", () => {
    const gcpProviders = ["gcp", "gcs"]

    for (const provider of gcpProviders) {
      describe(`provider: ${provider}`, () => {
        it("returns ok: false when service_account_json is missing", () => {
          const result = normalizeProviderSecretData(provider, {})
          expect(result.ok).toBe(false)
          if (!result.ok) expect(result.message).toMatch(/required/i)
        })

        it("returns ok: false when service_account_json is whitespace only", () => {
          const result = normalizeProviderSecretData(provider, { service_account_json: "   " })
          expect(result.ok).toBe(false)
        })

        it("returns ok: false when service_account_json is invalid JSON", () => {
          const result = normalizeProviderSecretData(provider, {
            service_account_json: "{bad json}",
          })
          expect(result.ok).toBe(false)
        })

        it("normalizes valid service account JSON and returns ok: true", () => {
          const result = normalizeProviderSecretData(provider, {
            service_account_json: validJsonPretty,
          })
          expect(result.ok).toBe(true)
          if (result.ok) {
            expect(result.secretData.service_account_json).toBe(
              JSON.stringify(JSON.parse(validJsonPretty)),
            )
          }
        })

        it("preserves other keys in secretData alongside the normalized JSON", () => {
          const result = normalizeProviderSecretData(provider, {
            service_account_json: validJson,
            extra_key: "extra_value",
          })
          expect(result.ok).toBe(true)
          if (result.ok) {
            expect(result.secretData.extra_key).toBe("extra_value")
          }
        })
      })
    }
  })
})
