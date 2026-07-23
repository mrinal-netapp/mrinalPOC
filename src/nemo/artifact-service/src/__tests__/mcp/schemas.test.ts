import {
  StoreIdField,
  PathField,
  RefField,
  ListStoresSchema,
  WhoamiSchema,
  ReadSchema,
  ListSchema,
  LogSchema,
  WriteSchema,
  DeleteSchema,
  TagSchema,
  RevertSchema,
  MergeSchema,
} from '../../mcp/schemas';

const VALID_STORE_ID = 'asabc12345';
const VALID_COMMIT = 'a'.repeat(40);

describe('MCP schema fields', () => {
  describe('StoreIdField', () => {
    it('accepts a well-formed store id', () => {
      expect(StoreIdField.safeParse(VALID_STORE_ID).success).toBe(true);
    });

    it('rejects wrong prefix', () => {
      expect(StoreIdField.safeParse('xsabc12345').success).toBe(false);
    });

    it('rejects wrong length', () => {
      expect(StoreIdField.safeParse('as123').success).toBe(false);
    });

    it('rejects uppercase chars', () => {
      expect(StoreIdField.safeParse('asABC12345').success).toBe(false);
    });
  });

  describe('PathField', () => {
    it('accepts a normal path', () => {
      expect(PathField.safeParse('dir/file.txt').success).toBe(true);
    });

    it('rejects empty', () => {
      expect(PathField.safeParse('').success).toBe(false);
    });

    it('rejects path traversal', () => {
      expect(PathField.safeParse('../etc/passwd').success).toBe(false);
    });
  });

  describe('RefField', () => {
    it('accepts a ref', () => {
      expect(RefField.safeParse('main').success).toBe(true);
    });

    it('accepts undefined (optional)', () => {
      expect(RefField.safeParse(undefined).success).toBe(true);
    });

    it('rejects empty string', () => {
      expect(RefField.safeParse('').success).toBe(false);
    });

    it('rejects over 255 chars', () => {
      expect(RefField.safeParse('x'.repeat(256)).success).toBe(false);
    });
  });
});

describe('MCP schemas', () => {
  describe('ListStoresSchema', () => {
    it('accepts empty object', () => {
      expect(ListStoresSchema.safeParse({}).success).toBe(true);
    });

    it('accepts optional fields', () => {
      expect(ListStoresSchema.safeParse({ project_id: 'p1', mine: true }).success).toBe(true);
    });

    it('rejects non-boolean mine', () => {
      expect(ListStoresSchema.safeParse({ mine: 'yes' }).success).toBe(false);
    });
  });

  describe('WhoamiSchema', () => {
    it('accepts empty object', () => {
      expect(WhoamiSchema.safeParse({}).success).toBe(true);
    });
  });

  describe('ReadSchema', () => {
    it('accepts a valid read request', () => {
      const r = ReadSchema.safeParse({ store_id: VALID_STORE_ID, path: 'a.txt', max_bytes: 1024 });
      expect(r.success).toBe(true);
    });

    it('rejects missing path', () => {
      expect(ReadSchema.safeParse({ store_id: VALID_STORE_ID }).success).toBe(false);
    });

    it('rejects non-positive max_bytes', () => {
      expect(
        ReadSchema.safeParse({ store_id: VALID_STORE_ID, path: 'a.txt', max_bytes: 0 }).success,
      ).toBe(false);
    });

    it('rejects non-integer max_bytes', () => {
      expect(
        ReadSchema.safeParse({ store_id: VALID_STORE_ID, path: 'a.txt', max_bytes: 1.5 }).success,
      ).toBe(false);
    });
  });

  describe('ListSchema', () => {
    it('accepts a valid list request', () => {
      const r = ListSchema.safeParse({
        store_id: VALID_STORE_ID,
        path: 'dir',
        recursive: true,
        limit: 10,
      });
      expect(r.success).toBe(true);
    });

    it('rejects bad store_id', () => {
      expect(ListSchema.safeParse({ store_id: 'bad' }).success).toBe(false);
    });
  });

  describe('LogSchema', () => {
    it('accepts a valid log request', () => {
      expect(
        LogSchema.safeParse({ store_id: VALID_STORE_ID, ref: 'main', limit: 5 }).success,
      ).toBe(true);
    });
  });

  describe('WriteSchema', () => {
    it('accepts a valid write request', () => {
      const r = WriteSchema.safeParse({
        store_id: VALID_STORE_ID,
        path: 'a.txt',
        content_base64: 'YWJj',
        message: 'add',
        idempotency_key: 'k1',
      });
      expect(r.success).toBe(true);
    });

    it('rejects missing content_base64', () => {
      expect(
        WriteSchema.safeParse({ store_id: VALID_STORE_ID, path: 'a.txt' }).success,
      ).toBe(false);
    });

    it('rejects path traversal', () => {
      expect(
        WriteSchema.safeParse({
          store_id: VALID_STORE_ID,
          path: '../x',
          content_base64: 'YWJj',
        }).success,
      ).toBe(false);
    });
  });

  describe('DeleteSchema', () => {
    it('accepts a valid delete request', () => {
      expect(
        DeleteSchema.safeParse({ store_id: VALID_STORE_ID, path: 'a.txt' }).success,
      ).toBe(true);
    });
  });

  describe('TagSchema', () => {
    it('accepts a valid tag request', () => {
      const r = TagSchema.safeParse({
        store_id: VALID_STORE_ID,
        name: 'v1',
        message: 'release',
      });
      expect(r.success).toBe(true);
    });

    it('rejects empty name', () => {
      expect(
        TagSchema.safeParse({ store_id: VALID_STORE_ID, name: '', message: 'm' }).success,
      ).toBe(false);
    });

    it('rejects empty message', () => {
      expect(
        TagSchema.safeParse({ store_id: VALID_STORE_ID, name: 'v1', message: '' }).success,
      ).toBe(false);
    });

    it('rejects name over 200 chars', () => {
      expect(
        TagSchema.safeParse({
          store_id: VALID_STORE_ID,
          name: 'x'.repeat(201),
          message: 'm',
        }).success,
      ).toBe(false);
    });
  });

  describe('RevertSchema', () => {
    it('accepts a 40-hex commit', () => {
      expect(
        RevertSchema.safeParse({ store_id: VALID_STORE_ID, commit: VALID_COMMIT }).success,
      ).toBe(true);
    });

    it('rejects a short commit', () => {
      expect(
        RevertSchema.safeParse({ store_id: VALID_STORE_ID, commit: 'abc' }).success,
      ).toBe(false);
    });

    it('rejects non-hex characters', () => {
      expect(
        RevertSchema.safeParse({ store_id: VALID_STORE_ID, commit: 'z'.repeat(40) }).success,
      ).toBe(false);
    });
  });

  describe('MergeSchema', () => {
    it('accepts ff-only strategy', () => {
      const r = MergeSchema.safeParse({
        store_id: VALID_STORE_ID,
        from_ref: 'sess',
        into: 'main',
        strategy: 'ff-only',
      });
      expect(r.success).toBe(true);
    });

    it('accepts omitted strategy', () => {
      expect(MergeSchema.safeParse({ store_id: VALID_STORE_ID }).success).toBe(true);
    });

    it('rejects an unsupported strategy', () => {
      expect(
        MergeSchema.safeParse({ store_id: VALID_STORE_ID, strategy: 'recursive' }).success,
      ).toBe(false);
    });
  });
});
