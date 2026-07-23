import { describe, expect, it } from "vitest"

import { parseProjectStorageRoot } from "./project-storage"

describe("parseProjectStorageRoot", () => {
  it("[tag:project-storage] parses an s3 home_dir into bucket and prefix", () => {
    expect(parseProjectStorageRoot("s3://my-bucket/projects/proj-1")).toEqual({
      bucketName: "my-bucket",
      pathPrefix: "projects/proj-1",
    })
  })

  it("[tag:project-storage] strips trailing slashes from the prefix", () => {
    expect(parseProjectStorageRoot("s3://my-bucket/projects/proj-1///")).toEqual({
      bucketName: "my-bucket",
      pathPrefix: "projects/proj-1",
    })
  })

  it("[tag:project-storage] returns null for undefined input", () => {
    expect(parseProjectStorageRoot(undefined)).toBeNull()
  })

  it("[tag:project-storage] returns null for null input", () => {
    expect(parseProjectStorageRoot(null)).toBeNull()
  })

  it("[tag:project-storage] returns null for an empty string", () => {
    expect(parseProjectStorageRoot("")).toBeNull()
  })

  it("[tag:project-storage] returns null for a non-string input", () => {
    // Defensive runtime guard: callers may pass an untyped value.
    expect(parseProjectStorageRoot(123 as unknown as string)).toBeNull()
  })

  it("[tag:project-storage] returns null for a non-s3 uri", () => {
    expect(parseProjectStorageRoot("https://example.com/foo")).toBeNull()
  })

  it("[tag:project-storage] returns null when there is no key after the bucket", () => {
    expect(parseProjectStorageRoot("s3://only-bucket")).toBeNull()
  })
})
